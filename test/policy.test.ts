import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_IP_WINDOW_SECONDS,
  MAX_LOGIN_STARTS_PER_IP_WINDOW,
  isActiveSubscriptionStatus,
  isExpiredTtl,
  isLoginStartRateLimited,
  isLockedUntil,
  isMembershipEntitled,
  nextLoginAttemptState,
  pickRedirectUrl,
  shouldThrottleLoginCode,
} from "../src/policy.js";

test("isExpiredTtl returns true when ttl has passed", () => {
  assert.equal(isExpiredTtl(99, 100), true);
  assert.equal(isExpiredTtl(100, 100), true);
  assert.equal(isExpiredTtl(101, 100), false);
});

test("login throttling and lock checks enforce resend cooldown windows", () => {
  assert.equal(shouldThrottleLoginCode(100, 120), true);
  assert.equal(shouldThrottleLoginCode(100, 161), false);
  assert.equal(isLockedUntil(200, 199), true);
  assert.equal(isLockedUntil(200, 200), false);
});

test("nextLoginAttemptState locks after the fifth failed attempt", () => {
  assert.deepEqual(nextLoginAttemptState(3, 100), { attempts: 4 });
  assert.deepEqual(nextLoginAttemptState(4, 100), {
    attempts: 5,
    lockedUntil: 700,
  });
});

test("isMembershipEntitled requires both paid status and matching mode", () => {
  assert.equal(
    isMembershipEntitled(
      {
        appId: "game-a",
        userId: "usr_123",
        email: "user@example.com",
        paid: true,
        mode: "managed",
        billingType: "subscription",
        updatedAt: "2026-02-28T00:00:00.000Z",
      },
      "managed",
    ),
    true,
  );

  assert.equal(
    isMembershipEntitled(
      {
        appId: "game-a",
        userId: "usr_123",
        email: "user@example.com",
        paid: false,
        updatedAt: "2026-02-28T00:00:00.000Z",
      },
      "managed",
    ),
    false,
  );
});

test("pickRedirectUrl accepts overrides on fallback or allowed origins", () => {
  assert.equal(
    pickRedirectUrl(" https://app.example.com/done ", "https://fallback.example.com", ["https://app.example.com"]),
    "https://app.example.com/done",
  );
  assert.equal(
    pickRedirectUrl("https://fallback.example.com/complete", "https://fallback.example.com", ["https://app.example.com"]),
    "https://fallback.example.com/complete",
  );
  assert.equal(pickRedirectUrl(undefined, "https://fallback.example.com", ["https://app.example.com"]), "https://fallback.example.com");
});

test("pickRedirectUrl rejects invalid or non-allowlisted overrides", () => {
  assert.throws(
    () => pickRedirectUrl("javascript:alert(1)", "https://fallback.example.com", ["https://app.example.com"]),
    /invalid_redirect_url/,
  );
  assert.throws(
    () => pickRedirectUrl("https://evil.example.com", "https://fallback.example.com", ["https://app.example.com"]),
    /invalid_redirect_url/,
  );
});

test("isLoginStartRateLimited enforces the per-IP auth start window", () => {
  assert.equal(
    isLoginStartRateLimited(MAX_LOGIN_STARTS_PER_IP_WINDOW, 100 + LOGIN_IP_WINDOW_SECONDS, 100),
    true,
  );
  assert.equal(
    isLoginStartRateLimited(MAX_LOGIN_STARTS_PER_IP_WINDOW - 1, 100 + LOGIN_IP_WINDOW_SECONDS, 100),
    false,
  );
  assert.equal(
    isLoginStartRateLimited(MAX_LOGIN_STARTS_PER_IP_WINDOW, 99, 100),
    false,
  );
});

test("isActiveSubscriptionStatus recognizes live subscription states", () => {
  assert.equal(isActiveSubscriptionStatus("active"), true);
  assert.equal(isActiveSubscriptionStatus("trialing"), true);
  assert.equal(isActiveSubscriptionStatus("past_due"), false);
});
