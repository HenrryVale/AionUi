/**
 * End-to-end unit tests for the Telegram → Team Mode dispatch flow, with every
 * external system faked.
 *
 * The behaviors pinned here are the ones that make the bridge correct:
 *  - the conversation boundary is captured BEFORE the run starts;
 *  - the boundary is an opaque cursor, never the team mailbox `message_id`;
 *  - only the Leader's visible text ever reaches Telegram;
 *  - the global FIFO keeps two runs from sharing a boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_QUEUE_DEPTH,
  createDispatcher,
  parseTelegramMessage,
} from '../../../../packages/web-host/src/telegram-team/dispatcher.js';
import type {
  AioncoreClient,
  BridgeDeps,
  LeaderMessage,
  LeaderMessagePage,
  RunWatcher,
  TeamRunAck,
  TeamRunOutcome,
  TelegramClient,
  TelegramTeamConfig,
  TelegramUpdate,
} from '../../../../packages/web-host/src/telegram-team/types.js';

const LEADER_CONVERSATION_ID = 'conv-leader';
const AUTHORIZED_CHAT = '111';
const UNAUTHORIZED_CHAT = '999';

const CONFIG: TelegramTeamConfig = {
  botToken: 'token-never-logged',
  teamId: 'team-1',
  allowedChatIds: new Set([AUTHORIZED_CHAT]),
  pollTimeoutS: 25,
  runTimeoutMs: 5_000,
};

type Op =
  | { op: 'getLeaderMessages'; after?: string; limit: number }
  | { op: 'sendTeamMessage'; content: string }
  | { op: 'waitForRun'; teamRunId: string }
  | { op: 'telegram'; chatId: string; text: string };

const leaderPage = (...texts: string[]): LeaderMessagePage => ({
  items: texts.map((content, index) => ({
    id: `m${index}`,
    type: 'text',
    position: 'left',
    content: { content },
  })),
});

const rawPage = (items: LeaderMessage[]): LeaderMessagePage => ({ items });

const update = (chatId: string, text: string, updateId = 1): TelegramUpdate => ({
  update_id: updateId,
  message: { text, chat: { id: Number(chatId) } },
});

type HarnessOptions = {
  /** `newest_cursor` handed back by each successive baseline (limit: 1) read. */
  baselines?: Array<string | null>;
  /** Pages handed back by each successive reply (limit > 1) read. */
  replies?: LeaderMessagePage[];
  acks?: TeamRunAck[];
  outcomes?: TeamRunOutcome[];
  sendTeamMessageError?: Error;
  baselineError?: Error;
  /** When set, `waitForRun` never settles until the returned release is called. */
  holdRuns?: boolean;
  waitForRunError?: Error;
};

function makeHarness(options: HarnessOptions = {}) {
  const ops: Op[] = [];
  const sent: Array<{ chatId: string; text: string }> = [];
  const baselines = [...(options.baselines ?? ['v1-baseline'])];
  const replies = [...(options.replies ?? [])];
  const acks = [...(options.acks ?? [])];
  const outcomes = [...(options.outcomes ?? [])];
  let releaseHeldRuns: (() => void) | undefined;

  const deps: BridgeDeps = {
    fetch: vi.fn(),
    createWebSocket: vi.fn(),
    sleep: vi.fn(async () => undefined),
    now: () => 0,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const aioncore: AioncoreClient = {
    getTeam: vi.fn(),
    async getLeaderMessages(_conversationId, opts) {
      ops.push({ op: 'getLeaderMessages', after: opts.after, limit: opts.limit });
      if (opts.limit === 1) {
        if (options.baselineError) throw options.baselineError;
        const cursor = baselines.length > 0 ? baselines.shift()! : null;
        return { items: [], newest_cursor: cursor };
      }
      return replies.length > 0 ? replies.shift()! : { items: [] };
    },
    async sendTeamMessage(_teamId, content) {
      ops.push({ op: 'sendTeamMessage', content });
      if (options.sendTeamMessageError) throw options.sendTeamMessageError;
      return acks.length > 0 ? acks.shift()! : { message_id: 'mailbox-msg', run: { team_run_id: 'run-1' } };
    },
  };

  const watcher: RunWatcher = {
    start: vi.fn(),
    stop: vi.fn(),
    waitForRun(teamRunId) {
      ops.push({ op: 'waitForRun', teamRunId });
      if (options.waitForRunError) return Promise.reject(options.waitForRunError);
      if (options.holdRuns) {
        return new Promise((resolve) => {
          releaseHeldRuns = () => resolve({ teamRunId, outcome: 'completed' });
        });
      }
      const outcome = outcomes.length > 0 ? outcomes.shift()! : 'completed';
      return Promise.resolve({ teamRunId, outcome });
    },
  };

  const telegram: TelegramClient = {
    getUpdates: vi.fn(async () => []),
    async sendMessage(chatId, text) {
      ops.push({ op: 'telegram', chatId, text });
      sent.push({ chatId, text });
    },
  };

  const dispatcher = createDispatcher({
    config: CONFIG,
    telegram,
    aioncore,
    watcher,
    deps,
    leaderConversationId: LEADER_CONVERSATION_ID,
  });

  return {
    dispatcher,
    ops,
    sent,
    deps,
    aioncore,
    release: () => releaseHeldRuns?.(),
    async flush() {
      await dispatcher.drainAndStop(2_000);
    },
  };
}

describe('parseTelegramMessage', () => {
  it('accepts a plain text message and stringifies the chat id', () => {
    expect(parseTelegramMessage(update('-1001234567890', 'hi'))).toEqual({
      chatId: '-1001234567890',
      text: 'hi',
    });
  });

  it('ignores edits, channel posts, bot authors and non-text messages', () => {
    expect(parseTelegramMessage({ update_id: 1, edited_message: {} })).toBeNull();
    expect(parseTelegramMessage({ update_id: 1, channel_post: {} })).toBeNull();
    expect(
      parseTelegramMessage({ update_id: 1, message: { text: 'x', chat: { id: 1 }, from: { is_bot: true } } })
    ).toBeNull();
    expect(parseTelegramMessage({ update_id: 1, message: { chat: { id: 1 } } })).toBeNull();
    expect(parseTelegramMessage({ update_id: 1, message: { text: '   ', chat: { id: 1 } } })).toBeNull();
  });
});

describe('dispatcher authorization', () => {
  it('never touches the team API for a chat outside the allowlist', async () => {
    const harness = makeHarness();
    harness.dispatcher.enqueue(update(UNAUTHORIZED_CHAT, 'let me in'));
    await harness.flush();

    expect(harness.ops.filter((op) => op.op === 'sendTeamMessage')).toHaveLength(0);
    expect(harness.ops.filter((op) => op.op === 'getLeaderMessages')).toHaveLength(0);
    expect(harness.sent).toEqual([{ chatId: UNAUTHORIZED_CHAT, text: expect.stringContaining('not authorized') }]);
  });

  it('sends exactly one team message for an authorized chat', async () => {
    const harness = makeHarness({ replies: [leaderPage('done')] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'status?'));
    await harness.flush();

    expect(harness.ops.filter((op) => op.op === 'sendTeamMessage')).toEqual([
      { op: 'sendTeamMessage', content: 'status?' },
    ]);
    expect(harness.sent).toEqual([{ chatId: AUTHORIZED_CHAT, text: 'done' }]);
  });
});

describe('conversation boundary correlation', () => {
  it('captures the baseline cursor before sending the team message', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], replies: [leaderPage('answer')] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const baselineIndex = harness.ops.findIndex((op) => op.op === 'getLeaderMessages' && op.limit === 1);
    const sendIndex = harness.ops.findIndex((op) => op.op === 'sendTeamMessage');
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThan(baselineIndex);
  });

  it('reads the reply slice with after=<baselineCursor> once the run completes', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], replies: [leaderPage('answer')] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(1);
    expect(replyReads[0]).toMatchObject({ after: 'v1-before' });

    const waitIndex = harness.ops.findIndex((op) => op.op === 'waitForRun');
    const replyIndex = harness.ops.findIndex((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyIndex).toBeGreaterThan(waitIndex);
  });

  it('never uses the team mailbox message_id as a cursor', async () => {
    const harness = makeHarness({
      baselines: ['v1-before'],
      acks: [{ message_id: 'mailbox-42', run: { team_run_id: 'run-1' } }],
      replies: [leaderPage('answer')],
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    for (const op of harness.ops) {
      if (op.op === 'getLeaderMessages') expect(op.after).not.toBe('mailbox-42');
    }
  });

  it('reads the whole page without a cursor when the conversation was empty before the run', async () => {
    const harness = makeHarness({ baselines: [null], replies: [leaderPage('first ever answer')] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(1);
    expect(replyReads[0].after).toBeUndefined();
    expect(harness.sent).toEqual([{ chatId: AUTHORIZED_CHAT, text: 'first ever answer' }]);
  });
});

describe('leader reply settling', () => {
  it('retries within a bounded budget when the leader text lands just after completion', async () => {
    const harness = makeHarness({
      baselines: ['v1-before'],
      replies: [rawPage([]), rawPage([]), leaderPage('late but consolidated')],
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(3);
    expect(harness.sent).toEqual([{ chatId: AUTHORIZED_CHAT, text: 'late but consolidated' }]);
  });

  it('stops retrying and falls back when the leader never produces text', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], replies: [] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(4);
    expect(harness.sent[0].text).toContain('without producing a text reply');
  });

  it('never relays a teammate message to Telegram', async () => {
    const harness = makeHarness({
      baselines: ['v1-before'],
      replies: [
        rawPage([
          {
            id: 'a',
            type: 'text',
            position: 'left',
            content: { content: 'teammate internal chatter', teammateMessage: true },
          },
          { id: 'b', type: 'text', position: 'left', content: { content: 'leader summary' } },
        ]),
      ],
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    expect(harness.sent).toEqual([{ chatId: AUTHORIZED_CHAT, text: 'leader summary' }]);
    expect(harness.sent[0].text).not.toContain('teammate internal chatter');
  });
});

describe('global FIFO queue', () => {
  it('gives two consecutive messages distinct boundaries and never mixes their replies', async () => {
    const harness = makeHarness({
      baselines: ['v1-A', 'v1-B'],
      acks: [
        { message_id: 'mailbox-1', run: { team_run_id: 'run-1' } },
        { message_id: 'mailbox-2', run: { team_run_id: 'run-2' } },
      ],
      replies: [leaderPage('answer one'), leaderPage('answer two')],
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'first', 1));
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'second', 2));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads.map((op) => op.after)).toEqual(['v1-A', 'v1-B']);
    expect(harness.sent).toEqual([
      { chatId: AUTHORIZED_CHAT, text: 'answer one' },
      { chatId: AUTHORIZED_CHAT, text: 'answer two' },
    ]);

    // The second run's boundary must be captured only after the first replied.
    const firstTelegram = harness.ops.findIndex((op) => op.op === 'telegram');
    const secondBaseline = harness.ops.findIndex(
      (op, index) => op.op === 'getLeaderMessages' && op.limit === 1 && index > firstTelegram
    );
    expect(secondBaseline).toBeGreaterThan(firstTelegram);
  });

  it('rejects messages past the queue cap instead of buffering them', async () => {
    const harness = makeHarness({ holdRuns: true });
    for (let i = 0; i < MAX_QUEUE_DEPTH + 2; i++) {
      harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, `msg ${i}`, i + 1));
    }
    // The rejection notices run on their own chain; give it a couple of ticks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.dispatcher.pendingCount()).toBeLessThanOrEqual(MAX_QUEUE_DEPTH);
    const busy = harness.sent.filter((message) => message.text.includes('busy'));
    expect(busy).toHaveLength(2);

    harness.release();
    await harness.flush();
  });

  it('stops accepting new work after drainAndStop', async () => {
    const harness = makeHarness({ replies: [leaderPage('answer')] });
    await harness.flush();
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'too late'));
    expect(harness.ops).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('reports a failed run without reading the leader conversation', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], outcomes: ['failed'] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(0);
    expect(harness.sent[0].text).toContain('did not finish successfully');
  });

  it('reports a cancelled run distinctly', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], outcomes: ['cancelled'] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();
    expect(harness.sent[0].text).toContain('cancelled');
  });

  it('reports a run timeout without cancelling anything', async () => {
    const harness = makeHarness({ baselines: ['v1-before'], waitForRunError: new Error('timed out') });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    expect(harness.sent[0].text).toContain('did not answer in time');
    const replyReads = harness.ops.filter((op) => op.op === 'getLeaderMessages' && op.limit > 1);
    expect(replyReads).toHaveLength(0);
  });

  it('releases the queue when aioncore is down at send time', async () => {
    const harness = makeHarness({
      baselines: ['v1-A', 'v1-B'],
      sendTeamMessageError: new Error('ECONNREFUSED'),
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'first', 1));
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'second', 2));
    await harness.flush();

    expect(harness.sent).toHaveLength(2);
    for (const message of harness.sent) expect(message.text).toContain('backend is unavailable');
    expect(harness.dispatcher.pendingCount()).toBe(0);
  });

  it('reports a backend failure when the baseline read fails', async () => {
    const harness = makeHarness({ baselineError: new Error('ECONNREFUSED') });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    expect(harness.ops.filter((op) => op.op === 'sendTeamMessage')).toHaveLength(0);
    expect(harness.sent[0].text).toContain('backend is unavailable');
  });

  it('reports a backend failure when the ack carries no team_run_id', async () => {
    const harness = makeHarness({ baselines: ['v1-A'], acks: [{ message_id: 'mailbox-1' }] });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    expect(harness.ops.filter((op) => op.op === 'waitForRun')).toHaveLength(0);
    expect(harness.sent[0].text).toContain('backend is unavailable');
  });

  it('treats blocked_runtime_starting as a valid ack and still waits for the run', async () => {
    const harness = makeHarness({
      baselines: ['v1-A'],
      acks: [{ enqueue_status: 'blocked_runtime_starting', message_id: 'm', run: { team_run_id: 'run-7' } }],
      replies: [leaderPage('answer after warmup')],
    });
    harness.dispatcher.enqueue(update(AUTHORIZED_CHAT, 'go'));
    await harness.flush();

    expect(harness.ops).toContainEqual({ op: 'waitForRun', teamRunId: 'run-7' });
    expect(harness.sent).toEqual([{ chatId: AUTHORIZED_CHAT, text: 'answer after warmup' }]);
  });
});

describe('startTelegramTeamBridge', () => {
  const BASE_ENV = {
    AIONUI_TEAM_TELEGRAM_ENABLED: '1',
    AIONUI_TEAM_TELEGRAM_BOT_TOKEN: 'secret-token',
    AIONUI_TEAM_TELEGRAM_TEAM_ID: 'team-1',
    AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS: AUTHORIZED_CHAT,
  } satisfies NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function importBridge() {
    return import('../../../../packages/web-host/src/telegram-team/index.js');
  }

  function makeDeps(fetchImpl: BridgeDeps['fetch']): Partial<BridgeDeps> {
    return {
      fetch: fetchImpl,
      createWebSocket: () => ({ addEventListener: () => undefined, close: () => undefined }),
      sleep: async () => undefined,
      now: () => 0,
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  const jsonResponse = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  it('stays disabled when the feature flag is off', async () => {
    const { startTelegramTeamBridge } = await importBridge();
    const fetchSpy = vi.fn();
    const handle = await startTelegramTeamBridge({
      backendPort: 13400,
      env: {},
      deps: makeDeps(fetchSpy as unknown as BridgeDeps['fetch']),
    });
    expect(handle).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the configured team does not exist', async () => {
    const { startTelegramTeamBridge } = await importBridge();
    const fetchSpy = vi.fn(async () => jsonResponse({}, 404));
    const handle = await startTelegramTeamBridge({
      backendPort: 13400,
      env: BASE_ENV,
      deps: makeDeps(fetchSpy as unknown as BridgeDeps['fetch']),
    });
    expect(handle).toBeNull();
  });

  it('fails closed when the team has no leader conversation', async () => {
    const { startTelegramTeamBridge } = await importBridge();
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { id: 'team-1', assistants: [{ slot_id: 's1', role: 'teammate' }] } })
    );
    const handle = await startTelegramTeamBridge({
      backendPort: 13400,
      env: BASE_ENV,
      deps: makeDeps(fetchSpy as unknown as BridgeDeps['fetch']),
    });
    expect(handle).toBeNull();
  });

  it('never creates a team or a conversation while starting', async () => {
    const { startTelegramTeamBridge } = await importBridge();
    const requests: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: { method?: string; signal?: AbortSignal }) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('api.telegram.org')) {
        // Park the long poll until shutdown aborts it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      return jsonResponse({
        data: { id: 'team-1', assistants: [{ slot_id: 's1', role: 'lead', conversation_id: LEADER_CONVERSATION_ID }] },
      });
    });

    const handle = await startTelegramTeamBridge({
      backendPort: 13400,
      env: BASE_ENV,
      deps: makeDeps(fetchSpy as unknown as BridgeDeps['fetch']),
    });
    expect(handle).not.toBeNull();
    await handle!.stop();

    const creations = requests.filter(
      (request) =>
        request.method === 'POST' && (request.url.endsWith('/api/teams') || request.url.endsWith('/api/conversations'))
    );
    expect(creations).toHaveLength(0);
  });

  it('runs a single poller even when start is called twice', async () => {
    const { startTelegramTeamBridge } = await importBridge();
    let telegramCalls = 0;
    const fetchSpy = vi.fn(async (input: unknown, init?: { signal?: AbortSignal }) => {
      const url = String(input);
      if (url.includes('api.telegram.org')) {
        telegramCalls++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      return jsonResponse({
        data: { id: 'team-1', assistants: [{ slot_id: 's1', role: 'lead', conversation_id: LEADER_CONVERSATION_ID }] },
      });
    });
    const deps = makeDeps(fetchSpy as unknown as BridgeDeps['fetch']);

    const first = await startTelegramTeamBridge({ backendPort: 13400, env: BASE_ENV, deps });
    const second = await startTelegramTeamBridge({ backendPort: 13400, env: BASE_ENV, deps });

    expect(second).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telegramCalls).toBe(1);
    await first!.stop();
  });
});
