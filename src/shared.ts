import { z } from "zod";

export const ModeSchema = z.enum(["byok", "managed"]);
export const BillingTypeSchema = z.enum(["subscription", "one_time"]);
export const ProviderSchema = z.enum(["openai", "anthropic", "openrouter"]);
export const PreferredThemeSchema = z.enum(["light", "dark", "system"]);
export const BillingSchemeSchema = z.enum(["flat", "metered"]);

export type Mode = z.infer<typeof ModeSchema>;
export type BillingType = z.infer<typeof BillingTypeSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type PreferredTheme = z.infer<typeof PreferredThemeSchema>;
export type BillingScheme = z.infer<typeof BillingSchemeSchema>;

export const AppCopySchema = z.object({
  heroSubtitle: z.string().min(1).optional(),
  accessSubtitle: z.string().min(1).optional(),
  plansSubtitle: z.string().min(1).optional(),
  byokSubtitle: z.string().min(1).optional(),
  tokenExplanation: z.string().min(1).optional(),
  tokenHelpUrl: z.string().url().optional(),
  tokenHelpLabel: z.string().min(1).optional(),
});

export type AppCopy = z.infer<typeof AppCopySchema>;

export const RelayMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

export type RelayMessage = z.infer<typeof RelayMessageSchema>;

export const AppPriceSchema = z
  .object({
    lookupKey: z.string().min(1),
    mode: ModeSchema,
    type: BillingTypeSchema,
    billingScheme: BillingSchemeSchema.default("flat"),
    unitAmountUsd: z.number().nonnegative(),
    billedUnitAmountUsd: z.number().nonnegative().optional(),
    interval: z.enum(["month", "year"]).optional(),
    stripePriceId: z.string().min(1).optional(),
    meterEventName: z.string().min(1).optional(),
    stripeMeterId: z.string().min(1).optional(),
    meterValueName: z.string().min(1).optional(),
    meterAggregationKey: z.string().min(1).optional(),
    includedUsageUnits: z.number().int().positive().optional(),
    billingPremiumPercent: z.number().nonnegative().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "subscription" && !value.interval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription prices require interval",
        path: ["interval"],
      });
    }

    if (value.type === "one_time" && value.interval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one_time prices must not include interval",
        path: ["interval"],
      });
    }

    if (value.billingScheme === "metered" && value.type !== "subscription") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metered prices must be subscriptions",
        path: ["type"],
      });
    }

    if (value.billingScheme === "metered" && value.mode !== "managed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metered prices must use managed mode",
        path: ["mode"],
      });
    }

    if (value.billingScheme === "metered" && !value.includedUsageUnits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metered prices require includedUsageUnits",
        path: ["includedUsageUnits"],
      });
    }

    if (value.billingScheme === "flat" && value.includedUsageUnits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "flat prices must not include includedUsageUnits",
        path: ["includedUsageUnits"],
      });
    }

    if (value.billingScheme === "flat" && value.billingPremiumPercent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "flat prices must not include billingPremiumPercent",
        path: ["billingPremiumPercent"],
      });
    }
  });

export type AppPrice = z.infer<typeof AppPriceSchema>;

export const LlmRelayRequestSchema = z.object({
  mode: ModeSchema,
  provider: ProviderSchema,
  model: z.string().min(1),
  messages: z.array(RelayMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(64000).optional(),
  stream: z.literal(false).optional(),
});

export type LlmRelayRequest = z.infer<typeof LlmRelayRequestSchema>;

export const LlmRelaySuccessResponseSchema = z.object({
  ok: z.literal(true),
  provider: ProviderSchema,
  mode: ModeSchema,
  model: z.string().min(1),
  outputText: z.string(),
  finishReason: z.string().min(1).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  upstream: z.unknown(),
});

export type LlmRelaySuccessResponse = z.infer<typeof LlmRelaySuccessResponseSchema>;

export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const AppBrandingSchema = z.object({
  appName: z.string().min(1),
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  supportUrl: z.string().url().optional(),
  legalText: z.string().min(1).optional(),
  preferredTheme: PreferredThemeSchema,
  allowedOrigins: z.array(z.string().url()),
  copy: AppCopySchema.optional(),
});

export type AppBranding = z.infer<typeof AppBrandingSchema>;

export const AppRecordSchema = z.object({
  appId: z.string().min(1),
  name: z.string().min(1),
  stripeProductId: z.string().min(1).optional(),
  branding: AppBrandingSchema,
  prices: z.array(AppPriceSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type AppRecord = z.infer<typeof AppRecordSchema>;

export const MembershipRecordSchema = z
  .object({
    appId: z.string().min(1),
    email: z.string().email(),
    paid: z.boolean(),
    lookupKey: z.string().min(1).optional(),
    mode: ModeSchema.optional(),
    billingType: BillingTypeSchema.optional(),
    billingScheme: BillingSchemeSchema.optional(),
    stripeCheckoutSessionId: z.string().min(1).optional(),
    stripeCustomerId: z.string().min(1).optional(),
    stripeSubscriptionId: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.paid && !value.mode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paid memberships require mode",
        path: ["mode"],
      });
    }

    if (value.paid && !value.billingType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paid memberships require billingType",
        path: ["billingType"],
      });
    }

    if (value.paid && !value.billingScheme) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paid memberships require billingScheme",
        path: ["billingScheme"],
      });
    }
  });

export type MembershipRecord = z.infer<typeof MembershipRecordSchema>;

export const StoredSessionRecordSchema = z.object({
  appId: z.string().min(1),
  email: z.string().email(),
  ttl: z.number().int().nonnegative(),
});

export type StoredSessionRecord = z.infer<typeof StoredSessionRecordSchema>;

export const ProviderKeyRecordSchema = z.object({
  appId: z.string().min(1),
  email: z.string().email(),
  provider: ProviderSchema,
  ciphertext: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ProviderKeyRecord = z.infer<typeof ProviderKeyRecordSchema>;

export const LoginCodeRecordSchema = z.object({
  codeHash: z.string().min(1),
  ttl: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative().optional(),
  lockedUntil: z.number().int().nonnegative().optional(),
  sentAt: z.number().int().nonnegative().optional(),
});

export type LoginCodeRecord = z.infer<typeof LoginCodeRecordSchema>;

export function buildLookupKey(input: {
  mode: string;
  type: string;
  interval?: string;
  amountCents: number;
}): string {
  return [input.mode, input.type, input.interval ?? "one_time", String(input.amountCents)].join("_");
}

export function parseCliPriceFlag(input: string): AppPrice {
  const [mode, type, intervalRaw, amountRaw, billingSchemeRaw, usageUnitsRaw, premiumPercentRaw] = input.split(":");
  if (!mode || !type || !intervalRaw || !amountRaw) {
    throw new Error(`Invalid --price format: ${input}`);
  }

  const amountCents = Number(amountRaw);
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    throw new Error(`Invalid price amount: ${input}`);
  }

  const interval = intervalRaw === "-" ? undefined : intervalRaw;
  const billingScheme = billingSchemeRaw === undefined ? "flat" : billingSchemeRaw;
  const includedUsageUnits =
    usageUnitsRaw === undefined || usageUnitsRaw === "-"
      ? undefined
      : Number.isFinite(Number(usageUnitsRaw)) && Number(usageUnitsRaw) > 0
        ? Number(usageUnitsRaw)
        : Number.NaN;
  const billingPremiumPercent =
    premiumPercentRaw === undefined || premiumPercentRaw === "-"
      ? undefined
      : Number.isFinite(Number(premiumPercentRaw)) && Number(premiumPercentRaw) >= 0
        ? Number(premiumPercentRaw)
        : Number.NaN;

  return AppPriceSchema.parse({
    lookupKey: buildLookupKey({
      mode,
      type,
      interval,
      amountCents,
    }),
    mode,
    type,
    billingScheme,
    interval,
    unitAmountUsd: amountCents,
    billedUnitAmountUsd: billingScheme === "metered" ? amountCents : undefined,
    includedUsageUnits,
    meterValueName: billingScheme === "metered" ? "tokens" : undefined,
    meterAggregationKey: billingScheme === "metered" ? "llm_total_tokens" : undefined,
    billingPremiumPercent,
  });
}

export function readPrices(value: unknown): AppPrice[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const row = z.record(z.string(), z.unknown()).parse(entry);
    const type = BillingTypeSchema.parse(row.type);
    const normalized = {
      lookupKey: z.string().min(1).parse(row.lookupKey),
      mode: ModeSchema.parse(row.mode),
      type,
      billingScheme:
        row.billingScheme === undefined ? "flat" : BillingSchemeSchema.parse(row.billingScheme),
      unitAmountUsd: z.number().nonnegative().parse(toNumber(row.unitAmountUsd)),
      billedUnitAmountUsd:
        row.billedUnitAmountUsd === undefined
          ? undefined
          : z.number().nonnegative().parse(toNumber(row.billedUnitAmountUsd)),
      interval:
        row.interval === undefined
          ? type === "subscription"
            ? "month"
            : undefined
          : z.enum(["month", "year"]).parse(row.interval),
      stripePriceId: row.stripePriceId === undefined ? undefined : z.string().min(1).parse(row.stripePriceId),
      meterEventName: row.meterEventName === undefined ? undefined : z.string().min(1).parse(row.meterEventName),
      stripeMeterId: row.stripeMeterId === undefined ? undefined : z.string().min(1).parse(row.stripeMeterId),
      meterValueName: row.meterValueName === undefined ? undefined : z.string().min(1).parse(row.meterValueName),
      meterAggregationKey:
        row.meterAggregationKey === undefined ? undefined : z.string().min(1).parse(row.meterAggregationKey),
      includedUsageUnits:
        row.includedUsageUnits === undefined
          ? undefined
          : z.number().int().positive().parse(toNumber(row.includedUsageUnits)),
      billingPremiumPercent:
        row.billingPremiumPercent === undefined
          ? undefined
          : z.number().nonnegative().max(500).parse(toNumber(row.billingPremiumPercent)),
    };

    return AppPriceSchema.parse(normalized);
  });
}

export function parseLlmRelayRequest(value: unknown): LlmRelayRequest {
  return LlmRelayRequestSchema.parse(value);
}

export function parseAppRecord(value: unknown): AppRecord {
  const row = record(value);
  return AppRecordSchema.parse({
    appId: z.string().min(1).parse(row.appId),
    name: z.string().min(1).parse(row.name),
    stripeProductId: optionalString(row.stripeProductId),
    branding: AppBrandingSchema.parse({
      appName: z.string().min(1).parse(record(row.branding).appName),
      logoUrl: optionalUrl(record(row.branding).logoUrl),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(record(row.branding).primaryColor),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(record(row.branding).accentColor),
      supportUrl: optionalUrl(record(row.branding).supportUrl),
      legalText: optionalString(record(row.branding).legalText),
      preferredTheme: PreferredThemeSchema.parse(record(row.branding).preferredTheme),
      allowedOrigins: z.array(z.string().url()).parse(record(row.branding).allowedOrigins),
      copy:
        record(row.branding).copy === undefined
          ? undefined
          : AppCopySchema.parse(record(row.branding).copy),
    }),
    prices: readPrices(row.prices),
    createdAt: z.string().min(1).parse(row.createdAt),
    updatedAt: z.string().min(1).parse(row.updatedAt),
  });
}

export function parseMembershipRecord(value: unknown): MembershipRecord {
  const row = record(value);
  return MembershipRecordSchema.parse({
    appId: z.string().min(1).parse(row.appId),
    email: z.string().email().parse(normalizeEmail(row.email)),
    paid: z.boolean().parse(row.paid),
    lookupKey: optionalString(row.lookupKey),
    mode: row.mode === undefined ? undefined : ModeSchema.parse(row.mode),
    billingType: row.billingType === undefined ? undefined : BillingTypeSchema.parse(row.billingType),
    billingScheme:
      row.billingScheme === undefined ? undefined : BillingSchemeSchema.parse(row.billingScheme),
    stripeCheckoutSessionId: optionalString(row.stripeCheckoutSessionId),
    stripeCustomerId: optionalString(row.stripeCustomerId),
    stripeSubscriptionId: optionalString(row.stripeSubscriptionId),
    updatedAt: z.string().min(1).parse(row.updatedAt),
  });
}

export function parseStoredSessionRecord(value: unknown): StoredSessionRecord {
  const row = record(value);
  return StoredSessionRecordSchema.parse({
    appId: z.string().min(1).parse(row.appId),
    email: z.string().email().parse(normalizeEmail(row.email)),
    ttl: z.number().int().nonnegative().parse(toNumber(row.ttl)),
  });
}

export function parseProviderKeyRecord(value: unknown): ProviderKeyRecord {
  const row = record(value);
  return ProviderKeyRecordSchema.parse({
    appId: z.string().min(1).parse(row.appId),
    email: z.string().email().parse(normalizeEmail(row.email)),
    provider: ProviderSchema.parse(row.provider),
    ciphertext: z.string().min(1).parse(row.ciphertext),
    updatedAt: z.string().min(1).parse(row.updatedAt),
  });
}

export function parseLoginCodeRecord(value: unknown): LoginCodeRecord {
  const row = record(value);
  return LoginCodeRecordSchema.parse({
    codeHash: z.string().min(1).parse(row.codeHash),
    ttl: z.number().int().nonnegative().parse(toNumber(row.ttl)),
    attempts: row.attempts === undefined ? undefined : z.number().int().nonnegative().parse(toNumber(row.attempts)),
    lockedUntil:
      row.lockedUntil === undefined ? undefined : z.number().int().nonnegative().parse(toNumber(row.lockedUntil)),
    sentAt: row.sentAt === undefined ? undefined : z.number().int().nonnegative().parse(toNumber(row.sentAt)),
  });
}

export function parseMode(value: unknown): Mode {
  return ModeSchema.parse(value);
}

export function parseBillingType(value: unknown): BillingType {
  return BillingTypeSchema.parse(value);
}

export function parseBillingScheme(value: unknown): BillingScheme {
  return BillingSchemeSchema.parse(value);
}

export function parseProvider(value: unknown): Provider {
  return ProviderSchema.parse(value);
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return z.string().min(1).parse(value);
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return z.string().url().parse(value);
}

function normalizeEmail(value: unknown): string {
  return z.string().min(1).parse(value).trim().toLowerCase();
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }

  return Number.NaN;
}
