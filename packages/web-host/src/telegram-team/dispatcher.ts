// Per-message flow and the global FIFO queue.
//
// Concurrency is deliberately 1. There is exactly one configured team, and
// aioncore already serializes runs within a team, so parallel dispatch would
// only move the queue server-side. More importantly, serialization is what makes
// the baseline cursor a safe boundary: if two runs overlapped in the leader
// conversation, the first run's cursor would sweep up the second run's reply.
//
// Reply texts below are operator-facing bot output from a headless bridge, not
// app UI — web-host has no i18n runtime and no renderer surface.

import { extractLeaderReply } from './leader-reply.js';
import type {
  AioncoreClient,
  BridgeDeps,
  RunWatcher,
  TelegramChatId,
  TelegramClient,
  TelegramTeamConfig,
  TelegramUpdate,
} from './types.js';

/** Messages beyond this many already-queued jobs are rejected, not buffered. */
export const MAX_QUEUE_DEPTH = 5;

/** Page size when reading the leader's reply slice. */
export const LEADER_PAGE_LIMIT = 200;

/**
 * Bounded settle budget: a run can report `runCompleted` a beat before the
 * leader's final text is committed. Immediate try, then 200/400/800 ms. Never
 * an unbounded poll.
 */
export const LEADER_SETTLE_DELAYS_MS = [0, 200, 400, 800];

const TEXT_UNAUTHORIZED = 'This chat is not authorized to use the AionUi team bridge.';
const TEXT_BUSY = 'The team is busy with queued work. Please retry in a moment.';
const TEXT_BACKEND_UNAVAILABLE = 'AionUi backend is unavailable right now. Please retry shortly.';
const TEXT_RUN_FAILED = 'The team run did not finish successfully.';
const TEXT_RUN_CANCELLED = 'The team run was cancelled.';
const TEXT_RUN_TIMEOUT = 'The team is still working and did not answer in time.';
const TEXT_EMPTY_REPLY = 'The leader finished the run without producing a text reply.';

type DispatcherOptions = {
  config: TelegramTeamConfig;
  telegram: TelegramClient;
  aioncore: AioncoreClient;
  watcher: RunWatcher;
  deps: BridgeDeps;
  /** Resolved once at startup and reused for every message. */
  leaderConversationId: string;
};

export type Dispatcher = {
  enqueue(update: TelegramUpdate): void;
  pendingCount(): number;
  drainAndStop(timeoutMs: number): Promise<void>;
};

type ParsedMessage = { chatId: TelegramChatId; text: string };

/** Swallow a settled rejection without widening the promise's type to `any`. */
const ignoreRejection = (): void => undefined;

/**
 * Narrow a raw update to the one shape the bridge acts on: a plain text message
 * from a human. Edits, channel posts and bot messages are ignored.
 */
export function parseTelegramMessage(update: TelegramUpdate | undefined): ParsedMessage | null {
  if (!update) return null;
  if (update.edited_message !== undefined || update.channel_post !== undefined) return null;
  const message = update.message;
  if (!message) return null;
  if (message.from?.is_bot === true) return null;
  const text = message.text?.trim();
  const rawChatId = message.chat?.id;
  if (!text || rawChatId === undefined || rawChatId === null) return null;
  return { chatId: String(rawChatId), text };
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { config, telegram, aioncore, watcher, deps, leaderConversationId } = options;

  let queueDepth = 0;
  let chain: Promise<void> = Promise.resolve();
  // Rejection notices (unauthorized / busy) run on their own chain. Queuing them
  // behind the work chain would delay a "busy" reply until the queue drained,
  // which is exactly when it stops being useful.
  let notices: Promise<void> = Promise.resolve();
  let accepting = true;

  function notify(chatId: TelegramChatId, text: string): void {
    notices = notices.then(() => telegram.sendMessage(chatId, text)).catch(ignoreRejection);
  }

  async function readLeaderReply(baselineCursor: string | null): Promise<string | null> {
    for (const delay of LEADER_SETTLE_DELAYS_MS) {
      if (delay > 0) await deps.sleep(delay);
      // `after` takes the OPAQUE cursor captured before the run started.
      // A null baseline means the conversation had no messages at all, so the
      // whole (still small) page is this run's output.
      const page = await aioncore.getLeaderMessages(leaderConversationId, {
        limit: LEADER_PAGE_LIMIT,
        ...(baselineCursor ? { after: baselineCursor } : {}),
      });
      const reply = extractLeaderReply(page);
      if (reply) return reply;
    }
    return null;
  }

  async function handle(chatId: TelegramChatId, text: string): Promise<void> {
    // 1. Snapshot the conversation boundary BEFORE the run starts. The cursor is
    //    opaque (`v1...`); `newest_cursor` is null when the conversation is empty.
    let baselineCursor: string | null;
    try {
      const baselinePage = await aioncore.getLeaderMessages(leaderConversationId, { limit: 1 });
      baselineCursor = baselinePage.newest_cursor ?? null;
    } catch (error) {
      deps.error(`[telegram-team] baseline read failed: ${String(error)}`);
      await telegram.sendMessage(chatId, TEXT_BACKEND_UNAVAILABLE);
      return;
    }

    // 2. Hand the message to the team; the route targets the leader server-side.
    let teamRunId: string | undefined;
    try {
      const ack = await aioncore.sendTeamMessage(config.teamId, text);
      // `blocked_runtime_starting` / `queued` are valid acknowledgements — the
      // run still exists and will emit its terminal event. Only a missing
      // team_run_id is unrecoverable.
      teamRunId = ack.run?.team_run_id;
    } catch (error) {
      deps.error(`[telegram-team] team message failed: ${String(error)}`);
      await telegram.sendMessage(chatId, TEXT_BACKEND_UNAVAILABLE);
      return;
    }

    if (!teamRunId) {
      deps.error('[telegram-team] team ack carried no run.team_run_id');
      await telegram.sendMessage(chatId, TEXT_BACKEND_UNAVAILABLE);
      return;
    }

    // 3. Wait for the terminal event of THIS run — this is what waits out the
    //    leader's delegations to teammates.
    let outcome: string;
    try {
      const terminal = await watcher.waitForRun(teamRunId, config.runTimeoutMs);
      outcome = terminal.outcome;
    } catch {
      // Timeout is not destructive: the run is left alone, never cancelled.
      await telegram.sendMessage(chatId, TEXT_RUN_TIMEOUT);
      return;
    }

    if (outcome !== 'completed') {
      // No conversation read on a failed/cancelled run.
      await telegram.sendMessage(chatId, outcome === 'cancelled' ? TEXT_RUN_CANCELLED : TEXT_RUN_FAILED);
      return;
    }

    // 4. Read only this run's slice and keep only the leader's visible text.
    let reply: string | null;
    try {
      reply = await readLeaderReply(baselineCursor);
    } catch (error) {
      deps.error(`[telegram-team] leader read failed: ${String(error)}`);
      await telegram.sendMessage(chatId, TEXT_BACKEND_UNAVAILABLE);
      return;
    }

    await telegram.sendMessage(chatId, reply ?? TEXT_EMPTY_REPLY);
  }

  return {
    enqueue(update: TelegramUpdate): void {
      if (!accepting) return;
      const parsed = parseTelegramMessage(update);
      if (!parsed) return;

      if (!config.allowedChatIds.has(parsed.chatId)) {
        // Deny-by-default: nothing reaches /api/teams/* for an unknown chat.
        notify(parsed.chatId, TEXT_UNAUTHORIZED);
        return;
      }

      if (queueDepth >= MAX_QUEUE_DEPTH) {
        notify(parsed.chatId, TEXT_BUSY);
        return;
      }

      queueDepth++;
      chain = chain
        .then(() => handle(parsed.chatId, parsed.text))
        .catch((error: unknown) => {
          deps.error(`[telegram-team] dispatch failed: ${String(error)}`);
        })
        .finally(() => {
          queueDepth--;
        });
    },

    pendingCount(): number {
      return queueDepth;
    },

    async drainAndStop(timeoutMs: number): Promise<void> {
      accepting = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      const settled = Promise.all([chain.catch(ignoreRejection), notices.catch(ignoreRejection)]);
      await Promise.race([settled, deadline]);
      if (timer) clearTimeout(timer);
    },
  };
}
