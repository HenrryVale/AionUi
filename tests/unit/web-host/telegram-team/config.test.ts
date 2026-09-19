/**
 * Unit tests for the Telegram → Team Mode bridge configuration.
 *
 * The bridge must be fail-closed: any missing or unusable value disables it
 * rather than starting a half-configured poller.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POLL_TIMEOUT_S,
  DEFAULT_RUN_TIMEOUT_MS,
  isEnvFlagEnabled,
  redactToken,
  resolveTelegramTeamConfig,
} from '../../../../packages/web-host/src/telegram-team/config.js';

const FULL_ENV = {
  AIONUI_TEAM_TELEGRAM_ENABLED: 'true',
  AIONUI_TEAM_TELEGRAM_BOT_TOKEN: '123456:ABC-DEF-token-value',
  AIONUI_TEAM_TELEGRAM_TEAM_ID: 'team-1',
  AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
} satisfies NodeJS.ProcessEnv;

describe('resolveTelegramTeamConfig', () => {
  it('returns null when the feature flag is absent even if every other value is set', () => {
    const { AIONUI_TEAM_TELEGRAM_ENABLED: _flag, ...withoutFlag } = FULL_ENV;
    expect(resolveTelegramTeamConfig(withoutFlag)).toBeNull();
  });

  it('returns null when the feature flag is explicitly off', () => {
    expect(resolveTelegramTeamConfig({ ...FULL_ENV, AIONUI_TEAM_TELEGRAM_ENABLED: 'false' })).toBeNull();
  });

  it('warns and disables the bridge when the bot token is missing', () => {
    const warn = vi.fn();
    const config = resolveTelegramTeamConfig({ ...FULL_ENV, AIONUI_TEAM_TELEGRAM_BOT_TOKEN: '   ' }, warn);
    expect(config).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('AIONUI_TEAM_TELEGRAM_BOT_TOKEN');
  });

  it('warns and disables the bridge when the team id is missing', () => {
    const warn = vi.fn();
    const config = resolveTelegramTeamConfig({ ...FULL_ENV, AIONUI_TEAM_TELEGRAM_TEAM_ID: '' }, warn);
    expect(config).toBeNull();
    expect(warn.mock.calls[0][0]).toContain('AIONUI_TEAM_TELEGRAM_TEAM_ID');
  });

  it('disables the bridge when the allowlist is absent (deny-by-default)', () => {
    const { AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS: _ids, ...withoutAllowlist } = FULL_ENV;
    const warn = vi.fn();
    expect(resolveTelegramTeamConfig(withoutAllowlist, warn)).toBeNull();
    expect(warn.mock.calls[0][0]).toContain('deny-by-default');
  });

  it('disables the bridge when the allowlist contains only separators and blanks', () => {
    const config = resolveTelegramTeamConfig({
      ...FULL_ENV,
      AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS: ' , ,, ',
    });
    expect(config).toBeNull();
  });

  it('parses an allowlist with padding and empty entries', () => {
    const config = resolveTelegramTeamConfig({
      ...FULL_ENV,
      AIONUI_TEAM_TELEGRAM_ALLOWED_CHAT_IDS: ' 111 ,,222,  -1001234567890 ',
    });
    expect(config).not.toBeNull();
    expect([...config!.allowedChatIds].toSorted()).toEqual(['-1001234567890', '111', '222']);
  });

  it('applies timeout defaults when the optional variables are absent', () => {
    const config = resolveTelegramTeamConfig(FULL_ENV);
    expect(config?.pollTimeoutS).toBe(DEFAULT_POLL_TIMEOUT_S);
    expect(config?.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it('falls back to the defaults when the timeout variables are not positive integers', () => {
    const config = resolveTelegramTeamConfig({
      ...FULL_ENV,
      AIONUI_TEAM_TELEGRAM_POLL_TIMEOUT_S: 'abc',
      AIONUI_TEAM_TELEGRAM_RUN_TIMEOUT_MS: '0',
    });
    expect(config?.pollTimeoutS).toBe(DEFAULT_POLL_TIMEOUT_S);
    expect(config?.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it('honors explicit timeout overrides', () => {
    const config = resolveTelegramTeamConfig({
      ...FULL_ENV,
      AIONUI_TEAM_TELEGRAM_POLL_TIMEOUT_S: '5',
      AIONUI_TEAM_TELEGRAM_RUN_TIMEOUT_MS: '1234',
    });
    expect(config?.pollTimeoutS).toBe(5);
    expect(config?.runTimeoutMs).toBe(1234);
  });

  it('keeps the resolved token out of any log-safe rendering', () => {
    const redacted = redactToken(FULL_ENV.AIONUI_TEAM_TELEGRAM_BOT_TOKEN);
    expect(redacted).not.toContain('ABC-DEF-token-value');
    expect(redacted).not.toContain('123456');
    expect(redactToken(undefined)).toBe('<unset>');
  });
});

describe('isEnvFlagEnabled', () => {
  it('accepts the documented truthy spellings', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(isEnvFlagEnabled(raw)).toBe(true);
    }
  });

  it('rejects anything else, including an empty string', () => {
    for (const raw of [undefined, '', '0', 'false', 'off', 'enabled']) {
      expect(isEnvFlagEnabled(raw)).toBe(false);
    }
  });
});
