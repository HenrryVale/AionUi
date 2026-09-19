// Environment-only configuration for the Telegram → Team Mode bridge.
//
// The bot token lives in `process.env` and nowhere else: it is never persisted,
// never exposed through an HTTP route, and never printed. The bridge adds no
// renderer surface, so there is no path for it to reach the frontend.
//
// Every resolution failure is fail-closed: `resolveTelegramTeamConfig` returns
// `null` and the caller skips the bridge. Starting the WebUI must never fail
// because of this feature.

import type { TelegramChatId, TelegramTeamConfig } from './types.js';

export const ENV_ENABLED = 'AIONUI_TEAM_TELEGRAM_ENABLED';
export const ENV_BOT_TOKEN = 'AIONUI_TEAM_TELEGRAM_BOT_TOKEN';
export const ENV_TEAM_ID = 'AIONUI_TEAM_TELEGRAM_TEAM_ID';
export const ENV_ALLOWED_CHAT_IDS = 'AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS';
export const ENV_POLL_TIMEOUT_S = 'AIONUI_TEAM_TELEGRAM_POLL_TIMEOUT_S';
export const ENV_RUN_TIMEOUT_MS = 'AIONUI_TEAM_TELEGRAM_RUN_TIMEOUT_MS';

export const DEFAULT_POLL_TIMEOUT_S = 25;
export const DEFAULT_RUN_TIMEOUT_MS = 900_000;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Matches `resolveAllowRemote` in web-cli so flag parsing stays consistent. */
export function isEnvFlagEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Render a token as `12345…`-style evidence that a value was present, without
 * ever revealing enough to use it. Used in log lines and error messages.
 */
export function redactToken(token: string | undefined): string {
  if (!token) return '<unset>';
  const trimmed = token.trim();
  if (trimmed.length <= 4) return '<redacted>';
  return `<redacted:${trimmed.length} chars>`;
}

function parseAllowlist(raw: string | undefined): Set<TelegramChatId> {
  if (!raw) return new Set();
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(ids);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return value > 0 ? value : fallback;
}

type ConfigWarn = (message: string) => void;

/**
 * Build the bridge configuration from env, or return `null` when the feature is
 * off or incompletely configured.
 */
export function resolveTelegramTeamConfig(
  env: NodeJS.ProcessEnv,
  warn: ConfigWarn = () => undefined
): TelegramTeamConfig | null {
  if (!isEnvFlagEnabled(env[ENV_ENABLED])) return null;

  const botToken = env[ENV_BOT_TOKEN]?.trim();
  if (!botToken) {
    warn(`[telegram-team] ${ENV_ENABLED} is on but ${ENV_BOT_TOKEN} is not set — bridge disabled.`);
    return null;
  }

  const teamId = env[ENV_TEAM_ID]?.trim();
  if (!teamId) {
    warn(`[telegram-team] ${ENV_ENABLED} is on but ${ENV_TEAM_ID} is not set — bridge disabled.`);
    return null;
  }

  // Deny-by-default: no allowlist means nobody is authorized, which makes a
  // running bridge pointless *and* is the safer reading of an empty value.
  const allowedChatIds = parseAllowlist(env[ENV_ALLOWED_CHAT_IDS]);
  if (allowedChatIds.size === 0) {
    warn(`[telegram-team] ${ENV_ALLOWED_CHAT_IDS} is empty — bridge disabled (deny-by-default).`);
    return null;
  }

  return {
    botToken,
    teamId,
    allowedChatIds,
    pollTimeoutS: parsePositiveInt(env[ENV_POLL_TIMEOUT_S], DEFAULT_POLL_TIMEOUT_S),
    runTimeoutMs: parsePositiveInt(env[ENV_RUN_TIMEOUT_MS], DEFAULT_RUN_TIMEOUT_MS),
  };
}
