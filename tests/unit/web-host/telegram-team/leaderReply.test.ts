/**
 * Unit tests for the Leader reply extractor.
 *
 * This is the guard that keeps team-internal traffic (teammate relays, tool
 * calls, hidden bookkeeping rows, the user's own bubble) out of Telegram.
 */

import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_MAX_MESSAGE_CHARS,
  chunkTelegramText,
  extractLeaderReply,
  isLeaderVisibleText,
} from '../../../../packages/web-host/src/telegram-team/leader-reply.js';
import type { LeaderMessage } from '../../../../packages/web-host/src/telegram-team/types.js';

const leaderText = (content: string, overrides: Partial<LeaderMessage> = {}): LeaderMessage => ({
  id: 'm1',
  type: 'text',
  position: 'left',
  content: { content },
  ...overrides,
});

describe('isLeaderVisibleText', () => {
  it('accepts a visible assistant-side text row', () => {
    expect(isLeaderVisibleText(leaderText('done'))).toBe(true);
  });

  it('rejects the user bubble, which is rendered on the right', () => {
    expect(isLeaderVisibleText(leaderText('my question', { position: 'right' }))).toBe(false);
  });

  it('rejects non-text rows such as tool calls and plans', () => {
    expect(isLeaderVisibleText(leaderText('ran ls', { type: 'tool_call' }))).toBe(false);
    expect(isLeaderVisibleText(leaderText('step 1', { type: 'plan' }))).toBe(false);
    expect(isLeaderVisibleText(leaderText('hmm', { type: 'thinking' }))).toBe(false);
  });

  it('rejects hidden rows', () => {
    expect(isLeaderVisibleText(leaderText('bookkeeping', { hidden: true }))).toBe(false);
  });

  it('rejects an empty or whitespace-only body', () => {
    expect(isLeaderVisibleText(leaderText('   '))).toBe(false);
    expect(isLeaderVisibleText(undefined)).toBe(false);
  });
});

describe('extractLeaderReply', () => {
  it('returns the leader text of a single-message page', () => {
    expect(extractLeaderReply({ items: [leaderText('consolidated answer')] })).toBe('consolidated answer');
  });

  it('never emits a teammate relay message', () => {
    const page = {
      items: [
        leaderText('teammate said something', { content: { content: 'internal', teammateMessage: true } }),
        leaderText('leader conclusion'),
      ],
    };
    const reply = extractLeaderReply(page);
    expect(reply).toBe('leader conclusion');
    expect(reply).not.toContain('internal');
  });

  it('returns null when the only rows are teammate relays', () => {
    const page = {
      items: [leaderText('x', { content: { content: 'teammate only', teammateMessage: true } })],
    };
    expect(extractLeaderReply(page)).toBeNull();
  });

  it('concatenates several leader fragments in page order', () => {
    const page = { items: [leaderText('first'), leaderText('second'), leaderText('third')] };
    expect(extractLeaderReply(page)).toBe('first\n\nsecond\n\nthird');
  });

  it('drops the user bubble, tool calls and hidden rows while keeping the leader text', () => {
    const page = {
      items: [
        leaderText('what is the status?', { position: 'right' }),
        leaderText('ls -la', { type: 'tool_call' }),
        leaderText('hidden note', { hidden: true }),
        leaderText('all three teammates finished'),
      ],
    };
    expect(extractLeaderReply(page)).toBe('all three teammates finished');
  });

  it('returns null for an empty page so the caller can retry then fall back', () => {
    expect(extractLeaderReply({ items: [] })).toBeNull();
    expect(extractLeaderReply({})).toBeNull();
    expect(extractLeaderReply(undefined)).toBeNull();
  });
});

describe('chunkTelegramText', () => {
  it('leaves a short message as a single chunk', () => {
    expect(chunkTelegramText('hello')).toEqual(['hello']);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkTelegramText('')).toEqual([]);
  });

  it('keeps a message exactly at the limit in one chunk', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(chunkTelegramText(text)).toHaveLength(1);
  });

  it('splits a message past the limit and preserves every character', () => {
    const text = 'b'.repeat(TELEGRAM_MAX_MESSAGE_CHARS + 500);
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a newline boundary in the back half of the window', () => {
    const head = 'c'.repeat(80);
    const tail = 'd'.repeat(60);
    const chunks = chunkTelegramText(`${head}\n${tail}`, 100);
    expect(chunks[0]).toBe(head);
    expect(chunks[1]).toBe(tail);
  });
});
