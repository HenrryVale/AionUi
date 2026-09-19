// Telegram → Team Mode bridge: lifecycle and long-polling loop.
//
// Off by default. `AIONUI_TEAM_TELEGRAM_ENABLED` must be truthy AND every other
// required variable present, or `startTelegramTeamBridge` returns null and the
// WebUI starts exactly as before.
//
// Runs a DEDICATED Telegram bot, separate from aioncore's native Telegram
// channel plugin — Telegram allows only one `getUpdates` consumer per token, so
// the two must never share one.

import { createAioncoreClient, resolveLeaderConversationId } from './aioncore-client.js';
import { resolveTelegramTeamConfig } from './config.js';
import { createDispatcher } from './dispatcher.js';
import { createRunWatcher } from './run-watcher.js';
import { createTelegramClient } from './telegram-api.js';
import type { BridgeDeps, BridgeSocket, TelegramTeamBridgeHandle } from './types.js';

const POLL_ERROR_BASE_MS = 1_000;
const POLL_ERROR_MAX_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 5_000;

export type StartTelegramTeamBridgeOptions = {
  /** Port of the already-running local aioncore instance. */
  backendPort: number;
  env: NodeJS.ProcessEnv;
  /** Overridable for tests; production uses the platform globals. */
  deps?: Partial<BridgeDeps>;
};

/**
 * Process-wide guard. Telegram drops one of two concurrent `getUpdates`
 * consumers, so a second poller would silently lose messages.
 */
let activeBridge: TelegramTeamBridgeHandle | null = null;

function buildDeps(overrides: Partial<BridgeDeps> | undefined): BridgeDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    createWebSocket: (url: string) => new globalThis.WebSocket(url) as unknown as BridgeSocket,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    now: () => Date.now(),
    log: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
    ...overrides,
  };
}

export async function startTelegramTeamBridge(
  options: StartTelegramTeamBridgeOptions
): Promise<TelegramTeamBridgeHandle | null> {
  const deps = buildDeps(options.deps);

  if (activeBridge) {
    deps.warn('[telegram-team] bridge already running — ignoring duplicate start.');
    return activeBridge;
  }

  const config = resolveTelegramTeamConfig(options.env, deps.warn);
  if (!config) return null;

  const aioncore = createAioncoreClient(options.backendPort, deps);

  // Fail closed: the bridge reuses an EXISTING team and the leader's EXISTING
  // conversation. If either is missing we refuse to start rather than create one.
  let leaderConversationId: string | null;
  try {
    const team = await aioncore.getTeam(config.teamId);
    leaderConversationId = resolveLeaderConversationId(team);
  } catch (error) {
    deps.error(`[telegram-team] could not load team ${config.teamId}: ${String(error)} — bridge disabled.`);
    return null;
  }

  if (!leaderConversationId) {
    deps.error(`[telegram-team] team ${config.teamId} has no leader conversation — bridge disabled.`);
    return null;
  }

  const telegram = createTelegramClient(config.botToken, deps);
  const watcher = createRunWatcher(options.backendPort, deps);
  const dispatcher = createDispatcher({ config, telegram, aioncore, watcher, deps, leaderConversationId });

  const abortController = new AbortController();
  let stopping = false;

  const pollLoop = (async () => {
    // Telegram semantics: `offset = -1` returns only the newest pending update.
    // Confirming it advances past the whole backlog, which is then discarded —
    // a restart must not replay messages sent while the bridge was down.
    let offset = -1;
    let primed = false;
    let errorAttempt = 0;

    while (!stopping) {
      let updates;
      try {
        updates = await telegram.getUpdates(offset, config.pollTimeoutS, abortController.signal);
        errorAttempt = 0;
      } catch (error) {
        if (stopping) break;
        const delay = Math.min(POLL_ERROR_BASE_MS * 2 ** errorAttempt, POLL_ERROR_MAX_MS);
        errorAttempt++;
        deps.warn(`[telegram-team] getUpdates failed, retrying in ${delay}ms: ${String(error)}`);
        await deps.sleep(delay);
        continue;
      }

      if (updates.length > 0) {
        offset = updates[updates.length - 1].update_id + 1;
      }

      if (!primed) {
        primed = true;
        if (updates.length > 0) {
          deps.log('[telegram-team] discarded Telegram backlog from before startup.');
        }
        continue;
      }

      for (const update of updates) {
        if (stopping) break;
        dispatcher.enqueue(update);
      }
    }
  })();

  watcher.start();
  deps.log(
    `[telegram-team] bridge enabled for team ${config.teamId} (${config.allowedChatIds.size} authorized chats).`
  );

  const handle: TelegramTeamBridgeHandle = {
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      // Abort the in-flight long poll so shutdown is not held for pollTimeoutS.
      abortController.abort();
      await pollLoop.catch((): void => undefined);
      // Let the message in flight finish, bounded. Runs still in flight are
      // abandoned without a reply; nothing is cancelled in aioncore.
      await dispatcher.drainAndStop(SHUTDOWN_DRAIN_MS);
      watcher.stop();
      if (activeBridge === handle) activeBridge = null;
      deps.log('[telegram-team] bridge stopped.');
    },
  };

  activeBridge = handle;
  return handle;
}

/** Stop the running bridge, if any. Safe to call when none is active. */
export async function stopTelegramTeamBridge(): Promise<void> {
  const current = activeBridge;
  if (!current) return;
  await current.stop();
  activeBridge = null;
}

export { resolveTelegramTeamConfig } from './config.js';
export type { TelegramTeamBridgeHandle, TelegramTeamConfig } from './types.js';
