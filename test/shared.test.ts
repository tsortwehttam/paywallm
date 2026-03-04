import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLookupKey,
  parseAppRecord,
  parseCliPriceFlag,
  parseLlmRelayRequest,
  parseMembershipRecord,
  parseLoginCodeRecord,
  parseProvider,
  parseProviderKeyRecord,
  parseStoredSessionRecord,
  readPrices,
} from "../src/shared.js";

test("buildLookupKey uses one_time when interval is omitted", () => {
  assert.equal(
    buildLookupKey({
      mode: "managed",
      type: "one_time",
      amountCents: 4999,
    }),
    "managed_one_time_one_time_4999",
  );
});

test("parseCliPriceFlag parses subscription pricing", () => {
  assert.deepEqual(parseCliPriceFlag("byok:subscription:month:500"), {
    lookupKey: "byok_subscription_month_500",
    mode: "byok",
    type: "subscription",
    billingScheme: "flat",
    interval: "month",
    unitAmountUsd: 500,
    billedUnitAmountUsd: undefined,
    meterValueName: undefined,
    meterAggregationKey: undefined,
    includedUsageUnits: undefined,
    billingPremiumPercent: undefined,
  });
});

test("parseCliPriceFlag parses one-time pricing", () => {
  assert.deepEqual(parseCliPriceFlag("managed:one_time:-:1999"), {
    lookupKey: "managed_one_time_one_time_1999",
    mode: "managed",
    type: "one_time",
    billingScheme: "flat",
    interval: undefined,
    unitAmountUsd: 1999,
    billedUnitAmountUsd: undefined,
    meterValueName: undefined,
    meterAggregationKey: undefined,
    includedUsageUnits: undefined,
    billingPremiumPercent: undefined,
  });
});

test("parseCliPriceFlag parses metered managed subscription pricing", () => {
  assert.deepEqual(parseCliPriceFlag("managed:subscription:month:15:metered:1000"), {
    lookupKey: "managed_subscription_month_15",
    mode: "managed",
    type: "subscription",
    billingScheme: "metered",
    interval: "month",
    unitAmountUsd: 15,
    billedUnitAmountUsd: 15,
    meterValueName: "tokens",
    meterAggregationKey: "llm_total_tokens",
    includedUsageUnits: 1000,
    billingPremiumPercent: undefined,
  });
});

test("parseCliPriceFlag parses metered premium percentages", () => {
  assert.deepEqual(parseCliPriceFlag("managed:subscription:month:15:metered:1000:25"), {
    lookupKey: "managed_subscription_month_15",
    mode: "managed",
    type: "subscription",
    billingScheme: "metered",
    interval: "month",
    unitAmountUsd: 15,
    billedUnitAmountUsd: 15,
    meterValueName: "tokens",
    meterAggregationKey: "llm_total_tokens",
    includedUsageUnits: 1000,
    billingPremiumPercent: 25,
  });
});

test("parseCliPriceFlag rejects malformed input", () => {
  assert.throws(() => parseCliPriceFlag("managed:subscription:month"), /Invalid --price format/);
});

test("readPrices normalizes stored records", () => {
  assert.deepEqual(
    readPrices([
        {
          lookupKey: "managed_subscription_month_1500",
          mode: "managed",
          type: "subscription",
          billingScheme: "flat",
          billedUnitAmountUsd: 1500,
          interval: "month",
          unitAmountUsd: 1500,
          stripePriceId: "price_123",
          meterEventName: undefined,
          stripeMeterId: undefined,
          meterValueName: undefined,
          meterAggregationKey: undefined,
          includedUsageUnits: undefined,
          billingPremiumPercent: undefined,
        },
        {
          lookupKey: "byok_one_time_one_time_999",
          mode: "byok",
          type: "one_time",
          billingScheme: "flat",
          billedUnitAmountUsd: 999,
          interval: undefined,
          unitAmountUsd: 999,
          stripePriceId: undefined,
          meterEventName: undefined,
          stripeMeterId: undefined,
          meterValueName: undefined,
          meterAggregationKey: undefined,
          includedUsageUnits: undefined,
          billingPremiumPercent: undefined,
        },
    ]),
    [
      {
        lookupKey: "managed_subscription_month_1500",
        mode: "managed",
        type: "subscription",
        billingScheme: "flat",
        billedUnitAmountUsd: 1500,
        interval: "month",
        unitAmountUsd: 1500,
        stripePriceId: "price_123",
        meterEventName: undefined,
        stripeMeterId: undefined,
        meterValueName: undefined,
        meterAggregationKey: undefined,
        includedUsageUnits: undefined,
        billingPremiumPercent: undefined,
      },
      {
        lookupKey: "byok_one_time_one_time_999",
        mode: "byok",
        type: "one_time",
        billingScheme: "flat",
        billedUnitAmountUsd: 999,
        interval: undefined,
        unitAmountUsd: 999,
        stripePriceId: undefined,
        meterEventName: undefined,
        stripeMeterId: undefined,
        meterValueName: undefined,
        meterAggregationKey: undefined,
        includedUsageUnits: undefined,
        billingPremiumPercent: undefined,
      },
    ],
  );
});

test("parseLlmRelayRequest parses the LLM relay body", () => {
  assert.deepEqual(
    parseLlmRelayRequest({
      mode: "managed",
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
      maxOutputTokens: 512,
    }),
    {
      mode: "managed",
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  );
});

test("parseLlmRelayRequest rejects invalid providers", () => {
  assert.throws(() =>
    parseLlmRelayRequest({
      mode: "managed",
      provider: "bad",
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
    }),
  );
});

test("parseLlmRelayRequest rejects empty message lists", () => {
  assert.throws(() =>
    parseLlmRelayRequest({
      mode: "managed",
      provider: "openrouter",
      model: "openrouter/auto",
      messages: [],
    }),
  );
});

test("parseProvider accepts anthropic and openrouter", () => {
  assert.equal(parseProvider("anthropic"), "anthropic");
  assert.equal(parseProvider("openrouter"), "openrouter");
});

test("parseAppRecord validates stored app rows", () => {
  assert.deepEqual(
    parseAppRecord({
      pk: "APP#game-a",
      sk: "APP#game-a",
      appId: "game-a",
      name: "Game A",
      stripeProductId: "prod_123",
      branding: {
        appName: "Game A",
        logoUrl: "https://example.com/logo.png",
        primaryColor: "#145af2",
        accentColor: "#0f172a",
        supportUrl: "https://example.com/support",
        legalText: "By continuing, you agree to the terms.",
        preferredTheme: "system",
        allowedOrigins: ["https://app.example.com"],
        copy: {
          plansSubtitle: "Pick the plan that works best for you.",
          byokSubtitle: "Paste your key from your AI provider dashboard.",
          tokenExplanation: "Tokens are how AI usage is measured.",
          tokenHelpUrl: "https://example.com/help/tokens",
          tokenHelpLabel: "What are tokens?",
        },
      },
      prices: [
        {
          lookupKey: "managed_subscription_month_1500",
          mode: "managed",
          type: "subscription",
          billingScheme: "metered",
          interval: "month",
          unitAmountUsd: 15,
          billedUnitAmountUsd: 19,
          stripePriceId: "price_123",
          stripeMeterId: "meter_123",
          meterEventName: "paywallm_game_a_usage",
          meterValueName: "tokens",
          meterAggregationKey: "llm_total_tokens",
          includedUsageUnits: 1000,
          billingPremiumPercent: 25,
        },
      ],
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    }),
    {
      appId: "game-a",
      name: "Game A",
      stripeProductId: "prod_123",
      branding: {
        appName: "Game A",
        logoUrl: "https://example.com/logo.png",
        primaryColor: "#145af2",
        accentColor: "#0f172a",
        supportUrl: "https://example.com/support",
        legalText: "By continuing, you agree to the terms.",
        preferredTheme: "system",
        allowedOrigins: ["https://app.example.com"],
        copy: {
          plansSubtitle: "Pick the plan that works best for you.",
          byokSubtitle: "Paste your key from your AI provider dashboard.",
          tokenExplanation: "Tokens are how AI usage is measured.",
          tokenHelpUrl: "https://example.com/help/tokens",
          tokenHelpLabel: "What are tokens?",
        },
      },
      prices: [
        {
          lookupKey: "managed_subscription_month_1500",
          mode: "managed",
          type: "subscription",
          billingScheme: "metered",
          interval: "month",
          unitAmountUsd: 15,
          billedUnitAmountUsd: 19,
          stripePriceId: "price_123",
          stripeMeterId: "meter_123",
          meterEventName: "paywallm_game_a_usage",
          meterValueName: "tokens",
          meterAggregationKey: "llm_total_tokens",
          includedUsageUnits: 1000,
          billingPremiumPercent: 25,
        },
      ],
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    },
  );
});

test("parseMembershipRecord validates paid memberships", () => {
  assert.deepEqual(
    parseMembershipRecord({
      appId: "game-a",
      email: "USER@example.com",
      paid: true,
      mode: "managed",
      billingType: "subscription",
      billingScheme: "metered",
      stripeCustomerId: "cus_123",
      updatedAt: "2026-02-27T00:00:00.000Z",
    }),
    {
      appId: "game-a",
      email: "user@example.com",
      paid: true,
      lookupKey: undefined,
      mode: "managed",
      billingType: "subscription",
      billingScheme: "metered",
      stripeCheckoutSessionId: undefined,
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: undefined,
      updatedAt: "2026-02-27T00:00:00.000Z",
    },
  );
});

test("parseStoredSessionRecord normalizes numeric ttl", () => {
  assert.deepEqual(
    parseStoredSessionRecord({
      appId: "game-a",
      email: "USER@example.com",
      ttl: "12345",
    }),
    {
      appId: "game-a",
      email: "user@example.com",
      ttl: 12345,
    },
  );
});

test("parseProviderKeyRecord validates encrypted BYOK rows", () => {
  assert.deepEqual(
    parseProviderKeyRecord({
      appId: "game-a",
      email: "USER@example.com",
      provider: "openrouter",
      ciphertext: "Zm9v",
      updatedAt: "2026-02-27T00:00:00.000Z",
    }),
    {
      appId: "game-a",
      email: "user@example.com",
      provider: "openrouter",
      ciphertext: "Zm9v",
      updatedAt: "2026-02-27T00:00:00.000Z",
    },
  );
});

test("parseLoginCodeRecord reads attempt metadata", () => {
  assert.deepEqual(
    parseLoginCodeRecord({
      codeHash: "abc123",
      ttl: "600",
      attempts: "2",
      lockedUntil: "900",
      sentAt: "300",
    }),
    {
      codeHash: "abc123",
      ttl: 600,
      attempts: 2,
      lockedUntil: 900,
      sentAt: 300,
    },
  );
});
