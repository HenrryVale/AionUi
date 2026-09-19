// Shared types and injectable ports for the Telegram → Team Mode bridge.
//
// The bridge talks to two external systems (Telegram Bot API and the local
// aioncore HTTP/WS API) and nothing else. Every side effect goes through a port
// declared here so the whole flow is unit-testable without a network.

/** Telegram chat id, kept as a string so 64-bit ids never lose precision. */
export type TelegramChatId = string;

/** Resolved bridge configuration. Only ever built from `process.env`. */
export type TelegramTeamConfig = {
  /** Bot token for the DEDICATED team bot. Never logged, never persisted. */
  botToken: string;
  /** Existing team id. The bridge never creates a team. */
  teamId: string;
  /** Deny-by-default allowlist; an empty allowlist disables the bridge. */
  allowedChatIds: ReadonlySet<TelegramChatId>;
  /** Telegram long-poll timeout, in seconds. */
  pollTimeoutS: number;
  /** Hard ceiling for waiting on one team run, in milliseconds. */
  runTimeoutMs: number;
};

/** The single Telegram update shape the bridge acts on. */
export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { is_bot?: boolean };
  };
  /** Present on edits / channel posts, which the bridge ignores. */
  edited_message?: unknown;
  channel_post?: unknown;
};

export type TelegramClient = {
  /** Long-polls Telegram. Resolves to `[]` when aborted or on a handled error. */
  getUpdates(offset: number, timeoutS: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  /** Sends text, chunked to Telegram's 4096-character limit. */
  sendMessage(chatId: TelegramChatId, text: string): Promise<void>;
};

/** One team member as returned by `GET /api/teams/{id}`. */
export type TeamAssistantSnapshot = {
  slot_id?: string;
  conversation_id?: string;
  /** Backend spells the leader role `lead`; `leader` is tolerated. */
  role?: string;
};

export type TeamSnapshot = {
  id?: string;
  assistants?: TeamAssistantSnapshot[];
  /** Legacy alias still emitted by older backends. */
  agents?: TeamAssistantSnapshot[];
};

/** `POST /api/teams/{id}/messages` acknowledgement. */
export type TeamRunAck = {
  enqueue_status?: string;
  /**
   * Team mailbox message id. NOT a conversation cursor and NOT the id of the
   * bubble projected into the leader conversation — never use it as `after`.
   */
  message_id?: string;
  run?: { team_run_id?: string };
};

/** Terminal outcome of one team run. */
export type TeamRunOutcome = 'completed' | 'failed' | 'cancelled';

export type TeamRunTerminalEvent = {
  teamRunId: string;
  outcome: TeamRunOutcome;
};

/** Minimal projection of a persisted conversation message. */
export type LeaderMessage = {
  id?: string;
  type?: string;
  position?: string;
  hidden?: boolean;
  content?: {
    content?: string;
    teammateMessage?: boolean;
  };
};

/** One keyset page of `GET /api/conversations/{id}/messages`. */
export type LeaderMessagePage = {
  items?: LeaderMessage[];
  oldest_cursor?: string | null;
  /** Opaque cursor (`v1...`). The bridge uses this — never a message id. */
  newest_cursor?: string | null;
  has_more_before?: boolean;
  has_more_after?: boolean;
};

export type AioncoreClient = {
  getTeam(teamId: string): Promise<TeamSnapshot>;
  /** Reads the newest page; `limit: 1` is how the baseline cursor is captured. */
  getLeaderMessages(conversationId: string, options: { after?: string; limit: number }): Promise<LeaderMessagePage>;
  sendTeamMessage(teamId: string, content: string): Promise<TeamRunAck>;
};

export type RunWatcher = {
  start(): void;
  stop(): void;
  /** Resolves on the terminal event for exactly this `teamRunId`. */
  waitForRun(teamRunId: string, timeoutMs: number): Promise<TeamRunTerminalEvent>;
};

/** Minimal WebSocket surface the run watcher needs. */
export type BridgeSocket = {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
};

/** Injectable side effects. Tests pass fakes for every one of them. */
export type BridgeDeps = {
  fetch: typeof globalThis.fetch;
  createWebSocket: (url: string) => BridgeSocket;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type TelegramTeamBridgeHandle = {
  stop: () => Promise<void>;
};
