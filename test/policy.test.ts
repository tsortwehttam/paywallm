import test from "node:test";
import assert from "node:assert/strict";
import {
  isActiveSubscriptionStatus,
  isExpiredTtl,
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

test("pickRedirectUrl prefers per-request overrides", () => {
  assert.equal(pickRedirectUrl(" https://app.example.com/done ", "https://fallback.example.com"), "https://app.example.com/done");
  assert.equal(pickRedirectUrl(undefined, "https://fallback.example.com"), "https://fallback.example.com");
});

test("isActiveSubscriptionStatus recognizes live subscription states", () => {
  assert.equal(isActiveSubscriptionStatus("active"), true);
  assert.equal(isActiveSubscriptionStatus("trialing"), true);
  assert.equal(isActiveSubscriptionStatus("past_due"), false);
});
