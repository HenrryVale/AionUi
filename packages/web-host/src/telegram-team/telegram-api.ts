// Minimal Telegram Bot API client — `getUpdates` and `sendMessage`, nothing else.
//
// The token appears only in the request URL. It is never included in log lines
// or thrown error messages: every failure path below reports the method name,
// not the URL.

import { chunkTelegramText } from './leader-reply.js';
import type { BridgeDeps, TelegramChatId, TelegramClient, TelegramUpdate } from './types.js';

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const SEND_MESSAGE_RETRIES = 2;

type TelegramEnvelope<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createTelegramClient(token: string, deps: BridgeDeps): TelegramClient {
  const endpoint = (method: string): string => `${TELEGRAM_API_ORIGIN}/bot${token}/${method}`;

  async function call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await deps.fetch(endpoint(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      // Deliberately reports the method, never the URL (which carries the token).
      throw new Error(`telegram ${method} failed with HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (envelope.ok === false) {
      throw new Error(`telegram ${method} rejected the request`);
    }
    return envelope.result as T;
  }

  return {
    async getUpdates(offset: number, timeoutS: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
      try {
        const updates = await call<TelegramUpdate[]>(
          'getUpdates',
          { offset, timeout: timeoutS, allowed_updates: ['message'] },
          signal
        );
        return Array.isArray(updates) ? updates : [];
      } catch (error) {
        // An aborted long-poll is the normal shutdown path, not a failure.
        if (isAbortError(error) || signal.aborted) return [];
        throw error;
      }
    },

    async sendMessage(chatId: TelegramChatId, text: string): Promise<void> {
      for (const chunk of chunkTelegramText(text)) {
        let lastError: unknown;
        let delivered = false;
        for (let attempt = 0; attempt <= SEND_MESSAGE_RETRIES; attempt++) {
          try {
            await call('sendMessage', { chat_id: chatId, text: chunk });
            delivered = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < SEND_MESSAGE_RETRIES) await deps.sleep(500 * (attempt + 1));
          }
        }
        if (!delivered) {
          // Dropping one chunk must not stall the queue; the run is already done.
          deps.error(`[telegram-team] sendMessage failed: ${String(lastError)}`);
          return;
        }
      }
    },
  };
}
