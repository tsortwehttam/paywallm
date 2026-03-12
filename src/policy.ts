import type { MembershipRecord, Mode } from "./shared.js";

export const LOGIN_CODE_RESEND_COOLDOWN_SECONDS = 60;
export const LOGIN_LOCK_SECONDS = 10 * 60;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_IP_WINDOW_SECONDS = 10 * 60;
export const MAX_LOGIN_STARTS_PER_IP_WINDOW = 10;

export function isExpiredTtl(ttl: number, nowSeconds = currentEpochSeconds()): boolean {
  return ttl <= nowSeconds;
}

export function isLockedUntil(
  lockedUntil: number | undefined,
  nowSeconds = currentEpochSeconds(),
): boolean {
  return typeof lockedUntil === "number" && lockedUntil > nowSeconds;
}

export function shouldThrottleLoginCode(
  sentAt: number | undefined,
  nowSeconds = currentEpochSeconds(),
): boolean {
  return typeof sentAt === "number" && sentAt + LOGIN_CODE_RESEND_COOLDOWN_SECONDS > nowSeconds;
}

export function nextLoginAttemptState(
  attempts: number | undefined,
  nowSeconds = currentEpochSeconds(),
): { attempts: number; lockedUntil?: number } {
  const nextAttempts = (attempts ?? 0) + 1;
  if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
    return {
      attempts: nextAttempts,
      lockedUntil: nowSeconds + LOGIN_LOCK_SECONDS,
    };
  }

  return { attempts: nextAttempts };
}

export function isMembershipEntitled(
  membership: MembershipRecord | undefined,
  mode: Mode,
): boolean {
  return Boolean(membership?.paid && membership.mode === mode);
}

export function isLoginStartRateLimited(
  count: number | undefined,
  ttl: number | undefined,
  nowSeconds = currentEpochSeconds(),
): boolean {
  return (
    typeof count === "number" &&
    count >= MAX_LOGIN_STARTS_PER_IP_WINDOW &&
    typeof ttl === "number" &&
    ttl > nowSeconds
  );
}

export function pickRedirectUrl(
  override: unknown,
  fallback: string,
  allowedOrigins: string[] = [],
): string {
  if (typeof override === "string" && override.trim().length > 0) {
    const candidate = parseAbsoluteUrl(override.trim());
    if (!candidate) {
      throw new Error("invalid_redirect_url");
    }

    const allowed = new Set<string>(allowedOrigins.map((origin) => parseAbsoluteUrl(origin)?.origin).filter(Boolean) as string[]);
    const fallbackOrigin = parseAbsoluteUrl(fallback)?.origin;
    if (fallbackOrigin) {
      allowed.add(fallbackOrigin);
    }

    if (!allowed.has(candidate.origin)) {
      throw new Error("invalid_redirect_url");
    }

    return candidate.toString();
  }

  return fallback;
}

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing";
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
