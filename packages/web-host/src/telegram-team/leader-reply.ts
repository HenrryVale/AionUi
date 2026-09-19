// Pure extraction of the Leader's consolidated reply.
//
// This module is the guard that keeps team-internal traffic out of Telegram.
// A team run projects several kinds of rows into the leader conversation: the
// user's own bubble, teammate relays, tool calls, plan/thinking frames and
// hidden bookkeeping rows. Only one of those is the consolidated answer.

import type { LeaderMessage, LeaderMessagePage } from './types.js';

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * True only for a visible, assistant-side text row authored by the Leader
 * itself.
 *
 * - `type === 'text'` drops tool calls, plans, thinking and status frames.
 * - `position === 'left'` drops the user's own message (rendered right).
 * - `hidden` rows are persisted but deliberately not shown to a human.
 * - `teammateMessage` marks a teammate's relay injected into the leader
 *   conversation — it is team-internal and must never reach Telegram.
 */
export function isLeaderVisibleText(message: LeaderMessage | undefined): boolean {
  if (!message) return false;
  if (message.type !== 'text') return false;
  if (message.position !== 'left') return false;
  if (message.hidden === true) return false;
  if (message.content?.teammateMessage === true) return false;
  return typeof message.content?.content === 'string' && message.content.content.trim().length > 0;
}

/**
 * Concatenate the Leader's visible text rows of one page, in page order.
 *
 * Returns `null` when the page carries no Leader text — the caller treats that
 * as "not settled yet" and retries within a bounded budget before falling back.
 */
export function extractLeaderReply(page: LeaderMessagePage | undefined): string | null {
  const items = page?.items;
  if (!Array.isArray(items)) return null;

  const parts: string[] = [];
  for (const message of items) {
    if (!isLeaderVisibleText(message)) continue;
    const text = message.content?.content;
    if (typeof text === 'string') parts.push(text.trim());
  }

  if (parts.length === 0) return null;
  const joined = parts.join('\n\n').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Split text into Telegram-sized chunks, preferring a newline boundary near the
 * limit so a split does not land mid-line. Always returns at least one chunk
 * for non-empty input.
 */
export function chunkTelegramText(text: string, limit: number = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  if (limit <= 0) return [text];
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf('\n');
    // Only honor a newline that is reasonably deep into the window; a very
    // early newline would produce many tiny chunks.
    const cut = breakAt > limit / 2 ? breakAt : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
