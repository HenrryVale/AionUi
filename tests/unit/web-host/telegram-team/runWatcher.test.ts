/**
 * Unit tests for team-run correlation over the aioncore realtime socket.
 *
 * Correlation must be strict (only the waiter's own team_run_id resolves it) and
 * race-proof (a run can finish before its POST returns the id).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunWatcher, parseRunEvent } from '../../../../packages/web-host/src/telegram-team/run-watcher.js';
import type { BridgeDeps, BridgeSocket } from '../../../../packages/web-host/src/telegram-team/types.js';

type Listeners = {
  open: Array<() => void>;
  close: Array<() => void>;
  error: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
};

class FakeSocket implements BridgeSocket {
  readonly listeners: Listeners = { open: [], close: [], error: [], message: [] };
  closed = false;

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: keyof Listeners, listener: unknown): void {
    (this.listeners[type] as unknown[]).push(listener);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(name: string, data: unknown): void {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify({ name, data }) });
  }

  emitClose(): void {
    for (const listener of this.listeners.close) listener();
  }
}

function makeHarness() {
  const sockets: FakeSocket[] = [];
  const deps: BridgeDeps = {
    fetch: vi.fn(),
    createWebSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    sleep: vi.fn(async () => undefined),
    now: () => Date.now(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const watcher = createRunWatcher(13400, deps);
  return { watcher, sockets, deps };
}

describe('parseRunEvent', () => {
  it('parses the confirmed { name, data } envelope', () => {
    const raw = JSON.stringify({ name: 'team.runCompleted', data: { team_run_id: 'run-1' } });
    expect(parseRunEvent(raw)).toEqual({ teamRunId: 'run-1', outcome: 'completed' });
  });

  it('maps every terminal event to its outcome', () => {
    const cases: Array<[string, string]> = [
      ['team.runCompleted', 'completed'],
      ['team.runFailed', 'failed'],
      ['team.runCancelled', 'cancelled'],
    ];
    for (const [name, outcome] of cases) {
      const raw = JSON.stringify({ name, data: { team_run_id: 'r' } });
      expect(parseRunEvent(raw)?.outcome).toBe(outcome);
    }
  });

  it('ignores non-terminal team events and unrelated frames', () => {
    expect(parseRunEvent(JSON.stringify({ name: 'team.runStarted', data: { team_run_id: 'r' } }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ name: 'team.teammateMessage', data: {} }))).toBeNull();
    expect(parseRunEvent('not json')).toBeNull();
    expect(parseRunEvent(42)).toBeNull();
  });

  it('ignores a terminal event with no usable team_run_id', () => {
    expect(parseRunEvent(JSON.stringify({ name: 'team.runCompleted', data: {} }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ name: 'team.runCompleted', data: { team_run_id: '' } }))).toBeNull();
  });

  it('tolerates the legacy { event, payload } spelling', () => {
    const raw = JSON.stringify({ event: 'team.runFailed', payload: { team_run_id: 'run-9' } });
    expect(parseRunEvent(raw)).toEqual({ teamRunId: 'run-9', outcome: 'failed' });
  });
});

describe('createRunWatcher', () => {
  let active: ReturnType<typeof makeHarness> | null = null;

  afterEach(() => {
    active?.watcher.stop();
    active = null;
  });

  it('resolves a waiter with the terminal event of its own run', async () => {
    active = makeHarness();
    active.watcher.start();
    const pending = active.watcher.waitForRun('run-1', 1000);
    active.sockets[0].emitMessage('team.runCompleted', { team_run_id: 'run-1' });
    await expect(pending).resolves.toEqual({ teamRunId: 'run-1', outcome: 'completed' });
  });

  it('ignores terminal events belonging to a different run', async () => {
    active = makeHarness();
    active.watcher.start();
    const pending = active.watcher.waitForRun('run-mine', 60);
    active.sockets[0].emitMessage('team.runCompleted', { team_run_id: 'run-other' });
    await expect(pending).rejects.toThrow(/timed out waiting for team run run-mine/);
  });

  it('resolves from the buffer when the run finished before the waiter registered', async () => {
    active = makeHarness();
    active.watcher.start();
    // Terminal event arrives while the POST that yields the id is still in flight.
    active.sockets[0].emitMessage('team.runCompleted', { team_run_id: 'run-fast' });
    await expect(active.watcher.waitForRun('run-fast', 1000)).resolves.toEqual({
      teamRunId: 'run-fast',
      outcome: 'completed',
    });
  });

  it('consumes a buffered event only once', async () => {
    active = makeHarness();
    active.watcher.start();
    active.sockets[0].emitMessage('team.runCompleted', { team_run_id: 'run-once' });
    await active.watcher.waitForRun('run-once', 1000);
    await expect(active.watcher.waitForRun('run-once', 60)).rejects.toThrow(/timed out/);
  });

  it('resolves failed and cancelled runs rather than hanging', async () => {
    active = makeHarness();
    active.watcher.start();
    const failed = active.watcher.waitForRun('run-f', 1000);
    const cancelled = active.watcher.waitForRun('run-c', 1000);
    active.sockets[0].emitMessage('team.runFailed', { team_run_id: 'run-f' });
    active.sockets[0].emitMessage('team.runCancelled', { team_run_id: 'run-c' });
    await expect(failed).resolves.toMatchObject({ outcome: 'failed' });
    await expect(cancelled).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('rejects on timeout', async () => {
    active = makeHarness();
    active.watcher.start();
    await expect(active.watcher.waitForRun('run-slow', 30)).rejects.toThrow(/timed out/);
  });

  it('reconnects after the socket closes', async () => {
    vi.useFakeTimers();
    try {
      active = makeHarness();
      active.watcher.start();
      expect(active.sockets).toHaveLength(1);
      active.sockets[0].emitClose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(active.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a single socket even when start is called twice', () => {
    active = makeHarness();
    active.watcher.start();
    active.watcher.start();
    expect(active.sockets).toHaveLength(1);
  });

  it('closes the socket and stops reconnecting on stop', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      harness.watcher.start();
      harness.watcher.stop();
      expect(harness.sockets[0].closed).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
