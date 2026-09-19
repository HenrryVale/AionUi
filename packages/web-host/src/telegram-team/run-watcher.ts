// Team run correlation over the aioncore realtime socket.
//
// One socket, shared by every dispatch. Correlation is strict: a waiter only
// ever resolves on the terminal event carrying its own `team_run_id`. Events for
// other runs are ignored, and "the most recent event" is never used as a proxy.
//
// Race handling: a short run can reach its terminal event before the HTTP POST
// that started it has returned the `team_run_id`. The watcher therefore buffers
// recent terminal events, and `waitForRun` consults that buffer before waiting.

import type { BridgeDeps, BridgeSocket, RunWatcher, TeamRunOutcome, TeamRunTerminalEvent } from './types.js';

const TERMINAL_EVENTS: Record<string, TeamRunOutcome> = {
  'team.runCompleted': 'completed',
  'team.runFailed': 'failed',
  'team.runCancelled': 'cancelled',
};

/** How long a terminal event stays available to a late `waitForRun`. */
export const RUN_EVENT_BUFFER_TTL_MS = 60_000;
/** Cap on buffered terminal events, so a long-lived bridge cannot grow forever. */
export const RUN_EVENT_BUFFER_MAX = 50;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type BufferedEvent = { event: TeamRunTerminalEvent; at: number };
type Waiter = (event: TeamRunTerminalEvent) => void;

/**
 * Parse one realtime frame.
 *
 * The confirmed envelope is `{ name, data }`; `{ event, payload }` is tolerated
 * because it costs one `??` and older frames used it.
 */
export function parseRunEvent(raw: unknown): TeamRunTerminalEvent | null {
  if (typeof raw !== 'string') return null;
  let frame: { name?: string; event?: string; data?: unknown; payload?: unknown };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  const name = frame.name ?? frame.event;
  if (!name) return null;
  const outcome = TERMINAL_EVENTS[name];
  if (!outcome) return null;

  const payload = (frame.data ?? frame.payload) as { team_run_id?: unknown } | undefined;
  const teamRunId = payload?.team_run_id;
  if (typeof teamRunId !== 'string' || teamRunId.length === 0) return null;

  return { teamRunId, outcome };
}

export function createRunWatcher(backendPort: number, deps: BridgeDeps): RunWatcher {
  const url = `ws://127.0.0.1:${backendPort}/ws`;
  const waiters = new Map<string, Set<Waiter>>();
  const buffer = new Map<string, BufferedEvent>();

  let socket: BridgeSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = true;

  function pruneBuffer(): void {
    const cutoff = deps.now() - RUN_EVENT_BUFFER_TTL_MS;
    for (const [key, entry] of buffer) {
      if (entry.at < cutoff) buffer.delete(key);
    }
    while (buffer.size > RUN_EVENT_BUFFER_MAX) {
      const oldest = buffer.keys().next();
      if (oldest.done) break;
      buffer.delete(oldest.value);
    }
  }

  function dispatch(event: TeamRunTerminalEvent): void {
    const pending = waiters.get(event.teamRunId);
    if (pending && pending.size > 0) {
      waiters.delete(event.teamRunId);
      for (const resolve of pending) resolve(event);
      return;
    }
    // Nobody is waiting yet — hold it for the in-flight POST to pick up.
    buffer.set(event.teamRunId, { event, at: deps.now() });
    pruneBuffer();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // A pending reconnect must never hold the process open at shutdown.
    reconnectTimer.unref?.();
  }

  function connect(): void {
    if (stopped) return;
    let current: BridgeSocket;
    try {
      current = deps.createWebSocket(url);
    } catch (error) {
      deps.warn(`[telegram-team] realtime socket failed to open: ${String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = current;

    current.addEventListener('open', () => {
      reconnectAttempt = 0;
    });
    current.addEventListener('message', (event: { data: unknown }) => {
      const parsed = parseRunEvent(event.data);
      if (parsed) dispatch(parsed);
    });
    current.addEventListener('close', () => {
      if (socket === current) socket = null;
      scheduleReconnect();
    });
    current.addEventListener('error', () => {
      try {
        current.close();
      } catch {
        /* closing a broken socket is best-effort */
      }
    });
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      reconnectAttempt = 0;
      connect();
    },

    stop(): void {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          /* best-effort */
        }
        socket = null;
      }
      waiters.clear();
      buffer.clear();
    },

    waitForRun(teamRunId: string, timeoutMs: number): Promise<TeamRunTerminalEvent> {
      const buffered = buffer.get(teamRunId);
      if (buffered) {
        buffer.delete(teamRunId);
        return Promise.resolve(buffered.event);
      }

      return new Promise<TeamRunTerminalEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.get(teamRunId)?.delete(waiter);
          reject(new Error(`timed out waiting for team run ${teamRunId}`));
        }, timeoutMs);
        timer.unref?.();

        const waiter: Waiter = (event) => {
          clearTimeout(timer);
          resolve(event);
        };

        const existing = waiters.get(teamRunId);
        if (existing) existing.add(waiter);
        else waiters.set(teamRunId, new Set([waiter]));
      });
    },
  };
}
