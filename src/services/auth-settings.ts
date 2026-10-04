import { LIMITS } from '../config/limits';
import type { StorageService } from './storage';

// Admin-configurable session lifetime. Default matches Vaultwarden's
// non-configurable behavior: a refresh session may live at most 365 days
// (the sliding idle window never exceeds this hard cap from creation).
// Admins can lower it; sessions are clamped at their next refresh, so a
// tightening takes effect without forcing a mass logout, and a loosening
// never extends sessions already in flight.

export const REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_DEFAULT = Math.round(
  LIMITS.auth.refreshTokenAbsoluteTtlMs / (24 * 60 * 60 * 1000)
);
export const REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_MIN = 1;
export const REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_MAX = REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_DEFAULT;
// Below this, re-login prompts become frequent enough to interrupt daily
// workflows on official clients — the API carries an explicit warning.
export const REFRESH_TOKEN_TTL_WARNING_THRESHOLD_DAYS = 30;

const AUTH_SESSION_SETTINGS_CONFIG_KEY = 'auth.session.settings.v1';

export interface AuthSessionSettings {
  refreshTokenAbsoluteTtlDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function refreshTokenLifetimeWarning(days: number): string | null {
  if (days >= REFRESH_TOKEN_TTL_WARNING_THRESHOLD_DAYS) return null;
  return (
    `Sessions will require a full re-login every ${days} day${days === 1 ? '' : 's'}. ` +
    `Values below ${REFRESH_TOKEN_TTL_WARNING_THRESHOLD_DAYS} days interrupt daily workflows: ` +
    'official desktop/mobile clients and browser extensions will prompt for the master password ' +
    'every few days on every device, and unsaved work in progress can be lost mid-session. ' +
    'The Bitwarden-aligned default is 365 days.'
  );
}

function sanitizeDays(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const days = Math.floor(parsed);
  if (days < REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_MIN || days > REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_MAX) {
    return null;
  }
  return days;
}

export async function getAuthSessionSettings(storage: StorageService): Promise<AuthSessionSettings> {
  const raw = await storage.getConfigValue(AUTH_SESSION_SETTINGS_CONFIG_KEY);
  if (!raw) {
    return { refreshTokenAbsoluteTtlDays: REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_DEFAULT };
  }
  try {
    const parsed = JSON.parse(raw) as { refreshTokenAbsoluteTtlDays?: unknown };
    const days = sanitizeDays(parsed?.refreshTokenAbsoluteTtlDays);
    return {
      refreshTokenAbsoluteTtlDays: days ?? REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_DEFAULT,
    };
  } catch {
    return { refreshTokenAbsoluteTtlDays: REFRESH_TOKEN_ABSOLUTE_TTL_DAYS_DEFAULT };
  }
}

export async function saveAuthSessionSettings(
  storage: StorageService,
  refreshTokenAbsoluteTtlDays: number
): Promise<void> {
  const days = sanitizeDays(refreshTokenAbsoluteTtlDays);
  if (days === null) {
    throw new Error('refreshTokenAbsoluteTtlDays out of range');
  }
  await storage.setConfigValue(
    AUTH_SESSION_SETTINGS_CONFIG_KEY,
    JSON.stringify({ refreshTokenAbsoluteTtlDays: days })
  );
}

export async function getRefreshTokenAbsoluteTtlMs(storage: StorageService): Promise<number> {
  const settings = await getAuthSessionSettings(storage);
  return settings.refreshTokenAbsoluteTtlDays * DAY_MS;
}
