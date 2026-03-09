import "dotenv/config";

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { randomBytes, createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { EncryptCommand, DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import Stripe from "stripe";
import { ZodError } from "zod";
import { buildProviderPayload, normalizeProviderResponse } from "./llm.js";
import {
  isActiveSubscriptionStatus,
  isExpiredTtl,
  isLockedUntil,
  isMembershipEntitled,
  nextLoginAttemptState,
  pickRedirectUrl,
  shouldThrottleLoginCode,
} from "./policy.js";
import {
  parseAppRecord,
  AppBrandingSchema,
  parseBillingScheme,
  parseBillingType,
  parseLlmRelayRequest,
  parseLoginCodeRecord,
  parseMembershipRecord,
  parseMode,
  parseProvider,
  parseIdentityRecord,
  parseProviderKeyRecord,
  parseStoredSessionRecord,
  parseUserRecord,
  parseCliPriceFlag,
  readPrices,
  type ApiErrorResponse,
  type AppBranding,
  type AppRecord,
  type AppPrice,
  type BillingScheme,
  type BillingType,
  type IdentityRecord,
  type LlmRelaySuccessResponse,
  type MembershipRecord,
  type Mode,
  type Provider,
  type UserRecord,
} from "./shared.js";

const env = {
  tableName: must("TABLE_NAME"),
  region: must("AWS_REGION"),
  accountId: must("AWS_ACCOUNT_ID"),
  kmsKeyId: must("AWS_KMS_KEY_ID"),
  stripeSecretKey: must("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: must("STRIPE_WEBHOOK_SECRET"),
  stripeSuccessUrl: must("STRIPE_SUCCESS_URL"),
  stripeCancelUrl: must("STRIPE_CANCEL_URL"),
  sesFromEmail: must("SES_FROM_EMAIL"),
  devEchoLoginCode: process.env.DEV_ECHO_LOGIN_CODE === "1",
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));
const kms = new KMSClient({ region: env.region });
const ses = new SESClient({ region: env.region });
const stripe = new Stripe(env.stripeSecretKey);

type JsonRecord = Record<string, unknown>;

type SessionRecord = {
  tokenHash: string;
  appId: string;
  userId: string;
  email?: string;
  expiresAt: number;
};

type SessionTransport = "cookie" | "token" | "both";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    if (event.requestContext.http.method === "OPTIONS") {
      const allowedOrigins = await resolveAllowedOriginsForEvent(event);
      return withCors(
        event,
        withAllowedOrigins(
          {
            statusCode: 204,
            headers: {},
          },
          allowedOrigins,
        ),
      );
    }

    const route = `${event.requestContext.http.method} ${event.rawPath}`;

    if (route === "GET /preview") return paywallBuilderPage(event);
    if (route === "GET /preview/paywall") return paywallPreviewPage(event);
    if (route === "GET /p/" + event.pathParameters?.appId) return paywallPage(event);
    if (route === "POST /auth/start") return withCors(event, await authStart(event));
    if (route === "POST /auth/verify") return withCors(event, await authVerify(event));
    if (route === "POST /auth/logout") return withCors(event, await authLogout(event));
    if (route === "GET /me") return withCors(event, await me(event));
    if (route === "POST /billing/checkout") return withCors(event, await billingCheckout(event));
    if (route === "POST /billing/portal") return withCors(event, await billingPortal(event));
    if (route === "POST /stripe/webhook") return withCors(event, await stripeWebhook(event));
    if (route === "POST /admin/apps") return withCors(event, await adminCreateApp(event));
    if (route === "GET /admin/apps") return withCors(event, await adminListApps());
    if (route === "PATCH /admin/apps/" + event.pathParameters?.appId) return withCors(event, await adminPatchApp(event));
    if (route === "GET /admin/apps/" + event.pathParameters?.appId + "/usage") {
      return withCors(event, await adminListUsage(event));
    }
    if (route === "POST /admin/apps/" + event.pathParameters?.appId + "/prices") {
      return withCors(event, await adminCreatePrices(event));
    }
    if (route === "POST /admin/users/" + event.pathParameters?.appId + "/" + event.pathParameters?.email + "/grant") {
      return withCors(event, await adminGrant(event, true));
    }
    if (route === "POST /admin/users/" + event.pathParameters?.appId + "/" + event.pathParameters?.email + "/revoke") {
      return withCors(event, await adminGrant(event, false));
    }

    if (event.requestContext.http.method === "POST" && event.rawPath.endsWith("/llm")) {
      return withCors(event, await llmRelay(event));
    }

    if (event.requestContext.http.method === "POST" && event.rawPath.endsWith("/keys")) {
      return withCors(event, await saveProviderKey(event));
    }

    return withCors(event, json(404, { error: "not_found" }));
  } catch (error) {
    if (error instanceof ZodError) {
      return withCors(
        event,
        withAllowedOrigins(
          json(400, {
            error: "validation_error",
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          }),
          await resolveAllowedOriginsForEvent(event),
        ),
      );
    }

    const message = error instanceof Error ? error.message : "unknown_error";
    return withCors(
      event,
      withAllowedOrigins(
        json(statusForError(message), { error: message }),
        await resolveAllowedOriginsForEvent(event),
      ),
    );
  }
}

async function authStart(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = await bodyJson(event);
  const appId = text(body.appId);
  const email = normalizeEmail(body.email);
  const app = await requireApp(appId);

  const loginItem = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("LOGIN", appId, email),
        sk: key("LOGIN", appId, email),
      },
    }),
  );

  if (loginItem.Item) {
    const existing = parseLoginCodeRecord(loginItem.Item);
    const nowSeconds = epochSeconds();

    if (isLockedUntil(existing.lockedUntil, nowSeconds)) {
      throw new Error("login_locked");
    }

    if (!isExpiredTtl(existing.ttl, nowSeconds) && shouldThrottleLoginCode(existing.sentAt, nowSeconds)) {
      throw new Error("login_code_recently_sent");
    }
  }

  const code = randomNumericCode();
  const ttl = ttlFromNow(10 * 60);
  const sentAt = epochSeconds();

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("LOGIN", appId, email),
        sk: key("LOGIN", appId, email),
        gsi1pk: key("APP", appId),
        gsi1sk: key("LOGIN", email),
        codeHash: sha256(code),
        ttl,
        attempts: 0,
        sentAt,
      },
    }),
  );

  await maybeSendCode(email, appId, code);

  return withAllowedOrigins(
    json(200, {
      ok: true,
      delivery: env.devEchoLoginCode ? "echo" : "email",
      code: env.devEchoLoginCode ? code : undefined,
    }),
    app.branding.allowedOrigins,
  );
}

async function authVerify(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = await bodyJson(event);
  const appId = text(body.appId);
  const email = normalizeEmail(body.email);
  const code = text(body.code);
  const sessionTransport = parseSessionTransport(body.sessionTransport);
  const app = await requireApp(appId);

  const loginItem = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("LOGIN", appId, email),
        sk: key("LOGIN", appId, email),
      },
    }),
  );

  if (!loginItem.Item) {
    return withAllowedOrigins(json(401, { error: "invalid_code" }), app.branding.allowedOrigins);
  }

  const loginRecord = parseLoginCodeRecord(loginItem.Item);
  if (isExpiredTtl(loginRecord.ttl)) {
    await ddb.send(
      new DeleteCommand({
        TableName: env.tableName,
        Key: {
          pk: key("LOGIN", appId, email),
          sk: key("LOGIN", appId, email),
        },
      }),
    );

    throw new Error("expired_code");
  }

  if (isLockedUntil(loginRecord.lockedUntil)) {
    throw new Error("login_locked");
  }

  if (loginRecord.codeHash !== sha256(code)) {
    const nextState = nextLoginAttemptState(loginRecord.attempts);

    await ddb.send(
      new PutCommand({
        TableName: env.tableName,
        Item: {
          pk: key("LOGIN", appId, email),
          sk: key("LOGIN", appId, email),
          gsi1pk: key("APP", appId),
          gsi1sk: key("LOGIN", email),
          codeHash: loginRecord.codeHash,
          ttl: loginRecord.ttl,
          attempts: nextState.attempts,
          lockedUntil: nextState.lockedUntil,
          sentAt: loginRecord.sentAt,
        },
      }),
    );

    if (nextState.lockedUntil) {
      throw new Error("login_locked");
    }

    return withAllowedOrigins(json(401, { error: "invalid_code" }), app.branding.allowedOrigins);
  }

  await ddb.send(
    new DeleteCommand({
      TableName: env.tableName,
      Key: {
        pk: key("LOGIN", appId, email),
        sk: key("LOGIN", appId, email),
      },
    }),
  );

  const token = randomToken();
  const tokenHash = sha256(token);
  const ttl = ttlFromNow(30 * 24 * 60 * 60);
  const user = await resolveOrCreateUserByEmail(email);

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("SESSION", tokenHash),
        sk: key("SESSION", tokenHash),
        gsi1pk: key("APP", appId),
        gsi1sk: key("SESSION", user.userId),
        appId,
        userId: user.userId,
        email,
        ttl,
      },
    }),
  );

  await ensureMembership(appId, user.userId, email);

  const response = {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    } as Record<string, string>,
    body: JSON.stringify({
      ok: true,
      sessionTransport,
      sessionToken: sessionTransport === "token" || sessionTransport === "both" ? token : undefined,
    }),
  };

  if (sessionTransport === "cookie" || sessionTransport === "both") {
    response.headers["set-cookie"] =
      `paywallm_session=${token}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  }

  return withAllowedOrigins(response, app.branding.allowedOrigins);
}

async function authLogout(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const token = readSessionToken(event);
  if (!token) {
    return json(200, { ok: true });
  }

  const session = await requireSession(event);
  const app = await requireApp(session.appId);

  await ddb.send(
    new DeleteCommand({
      TableName: env.tableName,
      Key: {
        pk: key("SESSION", sha256(token)),
        sk: key("SESSION", sha256(token)),
      },
    }),
  );

  return withAllowedOrigins({
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "paywallm_session=; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=0",
    },
    body: JSON.stringify({ ok: true }),
  }, app.branding.allowedOrigins);
}

async function me(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const session = await requireSession(event);
  const membership = await getMembership(session.appId, session.userId);
  const app = await requireApp(session.appId);
  const user = await requireUser(session.userId);
  const profileEmail = user.primaryEmail ?? session.email;

  return withAllowedOrigins(
    json(200, {
      appId: session.appId,
      user: {
        userId: user.userId,
        profileEmail,
      },
      session: {
        loginIdentity: {
          type: "email",
          email: session.email ?? profileEmail,
        },
      },
      membership,
      app,
    }),
    app.branding.allowedOrigins,
  );
}

async function paywallPage(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const app = await requireApp(text(event.pathParameters?.appId));
  const embed = readQueryParam(event, "embed") === "1";
  const prefillEmail = readQueryParam(event, "email") ?? "";
  const successUrl = readQueryParam(event, "success_url") ?? "";
  const cancelUrl = readQueryParam(event, "cancel_url") ?? "";
  const returnUrl = readQueryParam(event, "return_url") ?? "";
  const checkoutState = readQueryParam(event, "checkout") ?? "";
  const sessionTransport = paywallSessionTransport(readQueryParam(event, "session_transport"), embed);
  const html = renderPaywallHtml({
    app,
    embed,
    prefillEmail,
    successUrl,
    cancelUrl,
    returnUrl,
    checkoutState,
    sessionTransport,
  });

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": buildPaywallCsp(app.branding.allowedOrigins),
    },
    body: html,
  };
}

async function paywallPreviewPage(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const params = readQueryParams(event);
  const appId = previewParam(params, "app-id") ?? "preview-app";
  const name = previewParam(params, "name") ?? "Paywall Preview";

  const copy: Record<string, string> = {};
  const heroSubtitle = previewParam(params, "hero-subtitle");
  const accessSubtitle = previewParam(params, "access-subtitle");
  const plansSubtitle = previewParam(params, "plans-subtitle");
  const byokSubtitle = previewParam(params, "byok-subtitle");
  const managedSubscriptionLabel = previewParam(params, "managed-subscription-label");
  const byokSubscriptionLabel = previewParam(params, "byok-subscription-label");
  const tokenExplanation = previewParam(params, "token-explanation");
  const tokenHelpUrl = previewParam(params, "token-help-url");
  const tokenHelpLabel = previewParam(params, "token-help-label");
  if (heroSubtitle) copy.heroSubtitle = heroSubtitle;
  if (accessSubtitle) copy.accessSubtitle = accessSubtitle;
  if (plansSubtitle) copy.plansSubtitle = plansSubtitle;
  if (byokSubtitle) copy.byokSubtitle = byokSubtitle;
  if (managedSubscriptionLabel) copy.managedSubscriptionLabel = managedSubscriptionLabel;
  if (byokSubscriptionLabel) copy.byokSubscriptionLabel = byokSubscriptionLabel;
  if (tokenExplanation) copy.tokenExplanation = tokenExplanation;
  if (tokenHelpUrl) copy.tokenHelpUrl = tokenHelpUrl;
  if (tokenHelpLabel) copy.tokenHelpLabel = tokenHelpLabel;

  const branding = parseAppBranding(
    {
      appName: previewParam(params, "app-name") ?? name,
      logoUrl: previewParam(params, "logo-url"),
      primaryColor: previewParam(params, "primary-color"),
      accentColor: previewParam(params, "accent-color"),
      preferredTheme: previewParam(params, "theme"),
      supportUrl: previewParam(params, "support-url"),
      legalText: previewParam(params, "legal-text"),
      allowedOrigins: params.getAll("origin"),
      copy: Object.keys(copy).length > 0 ? copy : undefined,
    },
    name,
  );

  const prices = readPreviewPrices(params);
  const now = nowIso();
  const app: AppRecord = {
    appId,
    name,
    stripeProductId: undefined,
    branding,
    prices,
    createdAt: now,
    updatedAt: now,
  };

  const previewModeRaw = previewParam(params, "preview-mode");
  const previewMode = previewModeRaw === "managed" || previewModeRaw === "byok" ? previewModeRaw : undefined;
  const embed = readPreviewBoolean(params, "embed");
  const html = renderPaywallHtml({
    app,
    embed,
    prefillEmail: previewParam(params, "email") ?? "",
    successUrl: previewParam(params, "success-url") ?? "",
    cancelUrl: previewParam(params, "cancel-url") ?? "",
    returnUrl: previewParam(params, "return-url") ?? "",
    checkoutState: previewParam(params, "checkout-state") ?? "",
    sessionTransport: paywallSessionTransport(previewParam(params, "session-transport"), embed),
    preview: {
      enabled: true,
      email: previewParam(params, "preview-email") ?? "preview@example.com",
      paid: readPreviewBoolean(params, "preview-paid", true),
      mode:
        previewMode ??
        (prices.some((price) => price.mode === "byok") ? "byok" : "managed"),
    },
  });

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": buildPaywallCsp(branding.allowedOrigins),
    },
    body: html,
  };
}

async function paywallBuilderPage(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const html = renderPaywallBuilderHtml(event.rawPath);
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    },
    body: html,
  };
}

async function billingCheckout(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const session = await requireSession(event);
  const body = await bodyJson(event);
  const lookupKey = text(body.lookupKey);
  const successUrl = pickRedirectUrl(body.successUrl, env.stripeSuccessUrl);
  const cancelUrl = pickRedirectUrl(body.cancelUrl, env.stripeCancelUrl);
  const app = await requireApp(session.appId);
  const user = await requireUser(session.userId);
  const userEmail = requireUserEmail(user, session.email);
  const price = app.prices.find((entry) => entry.lookupKey === lookupKey);

  if (!price) {
    return json(400, { error: "price_not_found" });
  }

  if (isFreeByokPrice(price)) {
    await ddb.send(
      new PutCommand({
        TableName: env.tableName,
        Item: {
          pk: key("MEMBERSHIP", session.appId, session.userId),
          sk: key("MEMBERSHIP", session.appId, session.userId),
          gsi1pk: key("APP", session.appId),
          gsi1sk: key("MEMBERSHIP", userEmail),
          appId: session.appId,
          userId: session.userId,
          email: userEmail,
          paid: true,
          lookupKey: price.lookupKey,
          mode: price.mode,
          billingType: price.type,
          billingScheme: price.billingScheme,
          updatedAt: nowIso(),
        },
      }),
    );

    return withAllowedOrigins(
      json(200, {
        ok: true,
        free: true,
        lookupKey: price.lookupKey,
      }),
      app.branding.allowedOrigins,
    );
  }

  if (!price.stripePriceId) {
    return json(400, { error: "price_not_found" });
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  if (price.billingScheme === "metered") {
    lineItems.push({
      price: price.stripePriceId,
    });
    if (price.stripeBasePriceId) {
      lineItems.push({
        price: price.stripeBasePriceId,
        quantity: 1,
      });
    }
  } else {
    lineItems.push({
      price: price.stripePriceId,
      quantity: 1,
    });
  }

  const checkout = await stripe.checkout.sessions.create({
    mode: price.type === "subscription" ? "subscription" : "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems,
    metadata: {
      appId: session.appId,
      userId: session.userId,
      email: userEmail,
      lookupKey: price.lookupKey,
      mode: price.mode,
      billingType: price.type,
      billingScheme: price.billingScheme,
    },
    customer_email: userEmail,
  });

  return withAllowedOrigins(
    json(200, {
      ok: true,
      url: checkout.url,
      sessionId: checkout.id,
    }),
    app.branding.allowedOrigins,
  );
}

async function billingPortal(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const session = await requireSession(event);
  const body = await bodyJson(event, true);
  const membership = await getMembership(session.appId, session.userId);
  const app = await requireApp(session.appId);

  if (!membership?.stripeCustomerId) {
    return withAllowedOrigins(json(400, { error: "no_stripe_customer" }), app.branding.allowedOrigins);
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: text(membership.stripeCustomerId),
    return_url: pickRedirectUrl(body.returnUrl, env.stripeSuccessUrl),
  });

  return withAllowedOrigins(json(200, { ok: true, url: portal.url }), app.branding.allowedOrigins);
}

async function stripeWebhook(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = event.body ?? "";
  const signature = event.headers["stripe-signature"] ?? event.headers["Stripe-Signature"];
  if (!signature) {
    return json(400, { error: "missing_signature" });
  }

  const stripeEvent = stripe.webhooks.constructEvent(body, signature, env.stripeWebhookSecret);
  if (await isWebhookAlreadyProcessed(stripeEvent.id)) {
    return json(200, { received: true, duplicate: true });
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const checkout = stripeEvent.data.object as Stripe.Checkout.Session;
    const appId = checkout.metadata?.appId;
    const userId = checkout.metadata?.userId;
    const email = checkout.metadata?.email;
    const lookupKey = checkout.metadata?.lookupKey;
    const billingType =
      checkout.metadata?.billingType === undefined ? undefined : parseBillingType(checkout.metadata.billingType);
    const billingScheme =
      checkout.metadata?.billingScheme === undefined ? undefined : parseBillingScheme(checkout.metadata.billingScheme);
    const mode = checkout.metadata?.mode === undefined ? undefined : parseMode(checkout.metadata.mode);

    if (appId && userId && lookupKey && billingType && billingScheme && mode) {
      await ddb.send(
        new PutCommand({
          TableName: env.tableName,
          Item: {
            pk: key("MEMBERSHIP", appId, userId),
            sk: key("MEMBERSHIP", appId, userId),
            gsi1pk: key("APP", appId),
            gsi1sk: key("MEMBERSHIP", email ?? userId),
            appId,
            userId,
            email,
            paid: true,
            lookupKey,
            mode,
            billingType,
            billingScheme,
            stripeCheckoutSessionId: checkout.id,
            stripeCustomerId: textOrUndefined(checkout.customer),
            stripeSubscriptionId: textOrUndefined(checkout.subscription),
            updatedAt: nowIso(),
          },
        }),
      );

      await putSubscriptionIndex({
        appId,
        userId,
        email,
        stripeSubscriptionId: textOrUndefined(checkout.subscription),
      });
    }
  }

  if (stripeEvent.type === "customer.subscription.updated") {
    const subscription = stripeEvent.data.object as Stripe.Subscription;
    const membership = await findMembershipBySubscriptionId(subscription.id);
    if (membership) {
      await updateMembershipPaymentState(
        membership,
        isActiveSubscriptionStatus(subscription.status),
        textOrUndefined(subscription.customer),
      );
    }
  }

  if (stripeEvent.type === "customer.subscription.deleted") {
    const subscription = stripeEvent.data.object as Stripe.Subscription;
    const membership = await findMembershipBySubscriptionId(subscription.id);
    if (membership) {
      await updateMembershipPaymentState(
        membership,
        false,
        textOrUndefined(subscription.customer),
      );
    }
  }

  if (stripeEvent.type === "invoice.payment_failed") {
    const invoice = stripeEvent.data.object as Stripe.Invoice;
    const subscriptionId = textOrUndefined((invoice as { subscription?: unknown }).subscription);
    if (subscriptionId) {
      const membership = await findMembershipBySubscriptionId(subscriptionId);
      if (membership) {
        await updateMembershipPaymentState(
          membership,
          false,
          textOrUndefined(invoice.customer),
        );
      }
    }
  }

  await markWebhookProcessed(stripeEvent.id);

  return json(200, { received: true });
}

async function saveProviderKey(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const session = await requireSession(event);
  const appId = text(event.pathParameters?.appId);
  const app = await requireApp(appId);
  if (session.appId !== appId) {
    return withAllowedOrigins(json(403, { error: "session_app_mismatch" }), app.branding.allowedOrigins);
  }

  const body = await bodyJson(event);
  const provider = parseProvider(body.provider);
  const apiKey = text(body.apiKey);

  const ciphertext = await kms.send(
    new EncryptCommand({
      KeyId: env.kmsKeyId,
      Plaintext: Buffer.from(apiKey, "utf8"),
    }),
  );

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("PROVIDER_KEY", session.appId, session.userId, provider),
        sk: key("PROVIDER_KEY", session.appId, session.userId, provider),
        gsi1pk: key("APP", session.appId),
        gsi1sk: key("PROVIDER_KEY", session.userId, provider),
        appId: session.appId,
        userId: session.userId,
        provider,
        ciphertext: Buffer.from(ciphertext.CiphertextBlob ?? new Uint8Array()).toString("base64"),
        updatedAt: nowIso(),
      },
    }),
  );

  return withAllowedOrigins(json(200, { ok: true }), app.branding.allowedOrigins);
}

async function llmRelay(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const session = await requireSession(event);
  const appId = text(event.pathParameters?.appId);
  const app = await requireApp(appId);

  if (session.appId !== appId) {
    return withAllowedOrigins(json(403, { error: "session_app_mismatch" }), app.branding.allowedOrigins);
  }

  const membership = await getMembership(appId, session.userId);
  const request = parseLlmRelayRequest(await bodyJson(event));

  if (!membership) {
    return withAllowedOrigins(json(403, { error: "membership_missing" }), app.branding.allowedOrigins);
  }

  if (!isMembershipEntitled(membership, request.mode)) {
    return withAllowedOrigins(
      json(403, { error: membership.paid ? "mode_not_entitled" : "not_paid" }),
      app.branding.allowedOrigins,
    );
  }

  const entitledPrice = requireMembershipPrice(app, membership);
  const user = await requireUser(session.userId);
  const usageEmail = requireUserEmail(user, membership.email ?? session.email);

  const apiKey = await resolveProviderKey(appId, session.userId, request.provider, request.mode);

  const upstream = await callProvider({
    mode: request.mode,
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    apiKey,
    stripeCustomerId: membership.stripeCustomerId,
  });

  const normalized = normalizeProviderResponse(request.provider, upstream);
  const response: LlmRelaySuccessResponse = {
    ok: true,
    provider: request.provider,
    mode: request.mode,
    model: request.model,
    outputText: normalized.outputText,
    finishReason: normalized.finishReason,
    usage: normalized.usage,
    upstream,
  };

  await maybeRecordManagedUsage({
    appId,
    email: usageEmail,
    lookupKey: entitledPrice.lookupKey,
    stripeCustomerId: textOrUndefined(membership.stripeCustomerId),
    price: entitledPrice,
    mode: request.mode,
    provider: request.provider,
    model: request.model,
    usage: normalized.usage,
  });

  return withAllowedOrigins(json(200, response), app.branding.allowedOrigins);
}

async function adminCreateApp(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = await bodyJson(event);
  const appId = text(body.appId);
  const name = text(body.name);
  const prices = readPrices(body.prices);
  assertUniqueLookupKeys(prices);
  const branding = parseAppBranding(body.branding, name);
  const now = nowIso();

  const existing = await getApp(appId);
  if (existing) {
    return json(409, { error: "app_already_exists" });
  }

  let product: Stripe.Product | undefined;
  let createdPrices: AppPrice[] = [];

  try {
    product = await stripe.products.create({
      name,
      metadata: { appId },
    });

    for (const price of prices) {
      createdPrices.push(
        await createStripeBackedPrice({
          appId,
          appName: name,
          stripeProductId: product.id,
          price,
        }),
      );
    }
  } catch (error) {
    if (product) {
      await archiveStripeArtifacts(product.id, createdPrices);
    }
    throw error;
  }

  const record: AppRecord = {
    appId,
    name,
    stripeProductId: product.id,
    branding,
    prices: createdPrices,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: env.tableName,
        Item: {
          pk: key("APP", appId),
          sk: key("APP", appId),
          gsi1pk: "APP",
          gsi1sk: key("APP", appId),
          ...record,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    await archiveStripeArtifacts(product.id, createdPrices);
    throw error;
  }

  return json(201, {
    ok: true,
    app: record,
  });
}

async function adminListApps(): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.tableName,
      IndexName: "Gsi1",
      KeyConditionExpression: "gsi1pk = :gsi1pk",
      ExpressionAttributeValues: {
        ":gsi1pk": "APP",
      },
    }),
  );

  const apps = (result.Items ?? [])
    .filter((item) => item.pk === item.sk)
    .map((item) => parseAppRecord(item));
  return json(200, { apps });
}

async function adminPatchApp(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const appId = text(event.pathParameters?.appId);
  const body = await bodyJson(event);
  const name = textOrUndefined(body.name);
  const app = await requireApp(appId);
  const nextName = name ?? app.name;
  const branding = body.branding === undefined ? app.branding : parseAppBranding(body.branding, nextName, app.branding);

  if (!name && body.branding === undefined) {
    return json(400, { error: "nothing_to_update" });
  }

  app.name = nextName;
  app.branding = branding;
  app.updatedAt = nowIso();

  await putApp(app);

  return json(200, { ok: true });
}

async function adminCreatePrices(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const app = await requireApp(text(event.pathParameters?.appId));
  const body = await bodyJson(event);
  const prices = readPrices(body.prices);
  assertUniqueLookupKeys([...app.prices, ...prices]);
  const created: AppPrice[] = [];

  try {
    for (const price of prices) {
      created.push(
        await createStripeBackedPrice({
          appId: app.appId,
          appName: app.name,
          stripeProductId: app.stripeProductId,
          price,
        }),
      );
    }
  } catch (error) {
    await archiveStripePriceArtifacts(created);
    throw error;
  }

  app.prices.push(...created);
  app.updatedAt = nowIso();

  await putApp(app);

  return json(200, { ok: true, prices: created });
}

async function adminListUsage(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const appId = text(event.pathParameters?.appId);
  const app = await requireApp(appId);
  const email = readQueryParam(event, "email");
  const limitRaw = readQueryParam(event, "limit");
  const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 200) : 50;
  if (!Number.isFinite(limit)) {
    return json(400, { error: "invalid_limit" });
  }

  const prefix = email ? key("USAGE", normalizeEmail(email)) : "USAGE#";
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.tableName,
      IndexName: "Gsi1",
      KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: {
        ":gsi1pk": key("APP", appId),
        ":prefix": prefix,
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  const usage = (result.Items ?? []).map((item) => {
    const lookupKey = textOrUndefined(item.lookupKey);
    const price = lookupKey ? app.prices.find((entry) => entry.lookupKey === lookupKey) : undefined;
    const billedUnits = toFiniteNumber(item.billedUnits);
    const billedUnitAmountUsd =
      price && typeof price.billedUnitAmountUsd === "number" ? price.billedUnitAmountUsd : price?.unitAmountUsd;
    const estimatedChargeUsdCents =
      billedUnits !== undefined && typeof billedUnitAmountUsd === "number" ? billedUnits * billedUnitAmountUsd : undefined;

    return {
      appId: textOrUndefined(item.appId),
      email: textOrUndefined(item.email),
      provider: textOrUndefined(item.provider),
      model: textOrUndefined(item.model),
      lookupKey,
      meterEventName: textOrUndefined(item.meterEventName),
      tokenCount: toFiniteNumber(item.tokenCount),
      billedUnits,
      billedUnitAmountUsd,
      estimatedChargeUsdCents,
      reportedToStripe: item.reportedToStripe === true,
      createdAt: textOrUndefined(item.createdAt),
      reportedAt: textOrUndefined(item.reportedAt),
    };
  });

  return json(200, {
    appId,
    usage,
    count: usage.length,
  });
}

async function adminGrant(
  event: APIGatewayProxyEventV2,
  paid: boolean,
): Promise<APIGatewayProxyStructuredResultV2> {
  const appId = text(event.pathParameters?.appId);
  const email = normalizeEmail(event.pathParameters?.email);
  const body = await bodyJson(event, true);
  const user = await resolveOrCreateUserByEmail(email);

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("MEMBERSHIP", appId, user.userId),
        sk: key("MEMBERSHIP", appId, user.userId),
        gsi1pk: key("APP", appId),
        gsi1sk: key("MEMBERSHIP", email),
        appId,
        userId: user.userId,
        email,
        paid,
        mode: paid ? parseMode(body.mode ?? "managed") : undefined,
        billingType: paid ? parseBillingType(body.billingType ?? "one_time") : undefined,
        billingScheme: paid ? parseBillingScheme(body.billingScheme ?? "flat") : undefined,
        updatedAt: nowIso(),
      },
    }),
  );

  return json(200, { ok: true, paid });
}

async function maybeSendCode(email: string, appId: string, code: string): Promise<void> {
  if (env.devEchoLoginCode) {
    return;
  }

  await ses.send(
    new SendEmailCommand({
      Source: env.sesFromEmail,
      Destination: {
        ToAddresses: [email],
      },
      Message: {
        Subject: {
          Data: `Your ${appId} login code`,
        },
        Body: {
          Text: {
            Data: `Your login code is ${code}. It expires in 10 minutes.`,
          },
        },
      },
    }),
  );
}

async function requireSession(event: APIGatewayProxyEventV2): Promise<SessionRecord> {
  const token = readSessionToken(event);
  if (!token) {
    throw new Error("missing_session");
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("SESSION", sha256(token)),
        sk: key("SESSION", sha256(token)),
      },
    }),
  );

  if (!result.Item) {
    throw new Error("invalid_session");
  }

  const stored = parseStoredSessionRecord(result.Item);
  if (isExpiredTtl(stored.ttl)) {
    await ddb.send(
      new DeleteCommand({
        TableName: env.tableName,
        Key: {
          pk: key("SESSION", sha256(token)),
          sk: key("SESSION", sha256(token)),
        },
      }),
    );

    throw new Error("expired_session");
  }

  return {
    tokenHash: sha256(token),
    appId: stored.appId,
    userId: stored.userId,
    email: stored.email,
    expiresAt: stored.ttl,
  };
}

async function requireApp(appId: string): Promise<AppRecord> {
  const app = await getApp(appId);
  if (!app) {
    throw new Error("app_not_found");
  }

  return app;
}

async function getApp(appId: string): Promise<AppRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("APP", appId),
        sk: key("APP", appId),
      },
    }),
  );

  return result.Item ? parseAppRecord(result.Item) : undefined;
}

async function requireUser(userId: string): Promise<UserRecord> {
  const user = await getUser(userId);
  if (!user) {
    throw new Error("user_not_found");
  }
  return user;
}

async function getUser(userId: string): Promise<UserRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("USER", userId),
        sk: key("USER", userId),
      },
    }),
  );

  return result.Item ? parseUserRecord(result.Item) : undefined;
}

async function getEmailIdentity(email: string): Promise<IdentityRecord | undefined> {
  return getUserIdentity("email", email);
}

async function resolveOrCreateUserByEmail(email: string): Promise<UserRecord> {
  const existingIdentity = await getUserIdentity("email", email);
  if (existingIdentity) {
    return requireUser(existingIdentity.userId);
  }

  const userId = buildUserId();
  const now = nowIso();

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: env.tableName,
              Item: {
                pk: key("USER", userId),
                sk: key("USER", userId),
                gsi1pk: "USER",
                gsi1sk: key("USER", userId),
                userId,
                primaryEmail: email,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: env.tableName,
              Item: buildIdentityItem({
                userId,
                type: "email",
                key: email,
                email,
                now,
              }),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );

    return {
      userId,
      primaryEmail: email,
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    const identity = await getEmailIdentity(email);
    if (identity) {
      return requireUser(identity.userId);
    }
    throw error;
  }
}

async function getUserIdentity(type: IdentityRecord["type"], identityKey: string): Promise<IdentityRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("IDENTITY", type, identityKey),
        sk: key("IDENTITY", type, identityKey),
      },
    }),
  );

  return result.Item ? parseIdentityRecord(result.Item) : undefined;
}

async function listUserIdentities(userId: string): Promise<IdentityRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.tableName,
      IndexName: "Gsi1",
      KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: {
        ":gsi1pk": key("USER", userId),
        ":prefix": "IDENTITY#",
      },
    }),
  );

  return (result.Items ?? []).map((item) => parseIdentityRecord(item));
}

async function linkIdentityToUser(input: {
  userId: string;
  type: IdentityRecord["type"];
  identityKey: string;
  email?: string;
}): Promise<IdentityRecord> {
  const now = nowIso();

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: buildIdentityItem({
        userId: input.userId,
        type: input.type,
        key: input.identityKey,
        email: input.email,
        now,
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return {
    userId: input.userId,
    type: input.type,
    key: input.identityKey,
    email: input.email,
    createdAt: now,
    updatedAt: now,
  };
}

function buildIdentityItem(input: {
  userId: string;
  type: IdentityRecord["type"];
  key: string;
  email?: string;
  now: string;
}): Record<string, unknown> {
  return {
    pk: key("IDENTITY", input.type, input.key),
    sk: key("IDENTITY", input.type, input.key),
    gsi1pk: key("USER", input.userId),
    gsi1sk: key("IDENTITY", input.type, input.key),
    userId: input.userId,
    type: input.type,
    key: input.key,
    email: input.email,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function resolveAllowedOriginsForEvent(
  event: APIGatewayProxyEventV2,
): Promise<string[] | undefined> {
  const pathAppId = textOrUndefined(event.pathParameters?.appId);
  if (pathAppId) {
    const app = await getApp(pathAppId);
    return app?.branding.allowedOrigins;
  }

  if (event.rawPath === "/auth/start" || event.rawPath === "/auth/verify") {
    const body = await safeBodyJson(event);
    const bodyAppId = textOrUndefined(body?.appId);
    if (bodyAppId) {
      const app = await getApp(bodyAppId);
      return app?.branding.allowedOrigins;
    }
    return undefined;
  }

  if (
    event.rawPath === "/auth/logout" ||
    event.rawPath === "/me" ||
    event.rawPath === "/billing/checkout" ||
    event.rawPath === "/billing/portal"
  ) {
    try {
      const session = await requireSession(event);
      const app = await getApp(session.appId);
      return app?.branding.allowedOrigins;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function putApp(app: AppRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("APP", app.appId),
        sk: key("APP", app.appId),
        gsi1pk: "APP",
        gsi1sk: key("APP", app.appId),
        ...app,
      },
    }),
  );
}

async function ensureMembership(appId: string, userId: string, email?: string): Promise<void> {
  const existing = await getMembership(appId, userId);
  if (existing) {
    return;
  }

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("MEMBERSHIP", appId, userId),
        sk: key("MEMBERSHIP", appId, userId),
        gsi1pk: key("APP", appId),
        gsi1sk: key("MEMBERSHIP", email ?? userId),
        appId,
        userId,
        email,
        paid: false,
        updatedAt: nowIso(),
      },
    }),
  );
}

async function getMembership(appId: string, userId: string): Promise<MembershipRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("MEMBERSHIP", appId, userId),
        sk: key("MEMBERSHIP", appId, userId),
      },
    }),
  );

  return result.Item ? parseMembershipRecord(result.Item) : undefined;
}

async function findMembershipBySubscriptionId(
  stripeSubscriptionId: string,
): Promise<MembershipRecord | undefined> {
  const indexed = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("SUBSCRIPTION", stripeSubscriptionId),
        sk: key("SUBSCRIPTION", stripeSubscriptionId),
      },
    }),
  );

  if (indexed.Item) {
    const appId = textOrUndefined(indexed.Item.appId);
    const userId = textOrUndefined(indexed.Item.userId);
    if (appId && userId) {
      return getMembership(appId, userId);
    }
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: env.tableName,
      FilterExpression: "stripeSubscriptionId = :stripeSubscriptionId",
      ExpressionAttributeValues: {
        ":stripeSubscriptionId": stripeSubscriptionId,
      },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  if (!item) {
    return undefined;
  }

  const membership = parseMembershipRecord(item);
  await putSubscriptionIndex(membership);
  return membership;
}

async function updateMembershipPaymentState(
  membership: MembershipRecord,
  paid: boolean,
  stripeCustomerId?: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("MEMBERSHIP", membership.appId, membership.userId),
        sk: key("MEMBERSHIP", membership.appId, membership.userId),
        gsi1pk: key("APP", membership.appId),
        gsi1sk: key("MEMBERSHIP", membership.email ?? membership.userId),
        appId: membership.appId,
        userId: membership.userId,
        email: membership.email,
        paid,
        lookupKey: membership.lookupKey,
        mode: membership.mode,
        billingType: membership.billingType,
        billingScheme: membership.billingScheme,
        stripeCheckoutSessionId: membership.stripeCheckoutSessionId,
        stripeCustomerId: stripeCustomerId ?? membership.stripeCustomerId,
        stripeSubscriptionId: membership.stripeSubscriptionId,
        updatedAt: nowIso(),
      },
    }),
  );

  await putSubscriptionIndex({
    appId: membership.appId,
    userId: membership.userId,
    email: membership.email,
    stripeSubscriptionId: membership.stripeSubscriptionId,
  });
}

async function putSubscriptionIndex(input: {
  appId: string;
  userId: string;
  email?: string;
  stripeSubscriptionId?: string;
}): Promise<void> {
  if (!input.stripeSubscriptionId) {
    return;
  }

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: key("SUBSCRIPTION", input.stripeSubscriptionId),
        sk: key("SUBSCRIPTION", input.stripeSubscriptionId),
        gsi1pk: key("APP", input.appId),
        gsi1sk: key("SUBSCRIPTION", input.email ?? input.userId),
        appId: input.appId,
        userId: input.userId,
        email: input.email,
        stripeSubscriptionId: input.stripeSubscriptionId,
        updatedAt: nowIso(),
      },
    }),
  );
}

async function isWebhookAlreadyProcessed(eventId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("WEBHOOK", eventId),
        sk: key("WEBHOOK", eventId),
      },
    }),
  );

  return result.Item?.processed === true;
}

async function markWebhookProcessed(eventId: string): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.tableName,
        Item: {
          pk: key("WEBHOOK", eventId),
          sk: key("WEBHOOK", eventId),
          gsi1pk: "WEBHOOK",
          gsi1sk: key("WEBHOOK", eventId),
          stripeEventId: eventId,
          processed: true,
          createdAt: nowIso(),
          ttl: ttlFromNow(30 * 24 * 60 * 60),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      return;
    }
    throw error;
  }
}

async function archiveStripeArtifacts(
  stripeProductId: string,
  prices: AppPrice[],
): Promise<void> {
  await archiveStripePriceArtifacts(prices);

  try {
    await stripe.products.update(stripeProductId, { active: false });
  } catch {}
}

async function archiveStripePriceArtifacts(prices: AppPrice[]): Promise<void> {
  const seenPriceIds = new Set<string>();

  for (const price of prices) {
    for (const priceId of [price.stripePriceId, price.stripeBasePriceId]) {
      if (!priceId || seenPriceIds.has(priceId)) {
        continue;
      }
      seenPriceIds.add(priceId);

      try {
        await stripe.prices.update(priceId, { active: false });
      } catch {}
    }
  }
}

async function resolveProviderKey(
  appId: string,
  userId: string,
  provider: Provider,
  mode: Mode,
): Promise<string> {
  if (mode === "managed") {
    if (provider === "openrouter") {
      throw new Error("managed_provider_unsupported");
    }
    return env.stripeSecretKey;
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: {
        pk: key("PROVIDER_KEY", appId, userId, provider),
        sk: key("PROVIDER_KEY", appId, userId, provider),
      },
    }),
  );

  if (!result.Item) {
    throw new Error("missing_byok_provider_key");
  }

  const providerKey = parseProviderKeyRecord(result.Item);

  const decrypted = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(providerKey.ciphertext, "base64"),
    }),
  );

  return Buffer.from(decrypted.Plaintext ?? new Uint8Array()).toString("utf8");
}

async function callProvider(input: {
  mode: Mode;
  provider: Provider;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxOutputTokens?: number;
  apiKey: string;
  stripeCustomerId?: string;
}): Promise<unknown> {
  if (input.mode === "managed") {
    if (!input.stripeCustomerId) {
      throw new Error("missing_stripe_customer");
    }

    if (input.provider === "openai") {
      return postJson(
        "https://llm.stripe.com/responses",
        input.apiKey,
        buildProviderPayload({
          ...input,
          model: gatewayModelName(input.provider, input.model),
        }),
        {
          "X-Stripe-Customer-ID": input.stripeCustomerId,
        },
      );
    }

    return postJson(
      "https://llm.stripe.com/v1/messages",
      input.apiKey,
      buildProviderPayload({
        ...input,
        model: gatewayModelName(input.provider, input.model),
      }),
      {
        "X-Stripe-Customer-ID": input.stripeCustomerId,
      },
    );
  }

  if (input.provider === "openai") {
    return postJson(
      "https://api.openai.com/v1/responses",
      input.apiKey,
      buildProviderPayload({
        ...input,
        model: directModelName(input.provider, input.model),
      }),
    );
  }

  if (input.provider === "anthropic") {
    return postJson(
      "https://api.anthropic.com/v1/messages",
      input.apiKey,
      buildProviderPayload({
        ...input,
        model: directModelName(input.provider, input.model),
      }),
      {
        "anthropic-version": "2023-06-01",
      },
      "x-api-key",
    );
  }

  return postJson(
    "https://openrouter.ai/api/v1/chat/completions",
    input.apiKey,
    buildProviderPayload({
      ...input,
      model: directModelName(input.provider, input.model),
    }),
  );
}

function gatewayModelName(provider: Provider, model: string): string {
  if (model.includes("/")) {
    return model;
  }
  return `${provider}/${model}`;
}

function directModelName(provider: Provider, model: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

async function postJson(
  url: string,
  apiKey: string,
  payload: JsonRecord,
  extraHeaders: Record<string, string> = {},
  authHeader = "authorization",
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

  headers[authHeader] = authHeader === "authorization" ? `Bearer ${apiKey}` : apiKey;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const textBody = await response.text();
  let parsed: unknown = textBody;

  try {
    parsed = JSON.parse(textBody);
  } catch {}

  if (!response.ok) {
    throw new Error(`provider_error:${response.status}:${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function readSessionToken(event: APIGatewayProxyEventV2): string | undefined {
  const auth = event.headers.authorization ?? event.headers.Authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }

  const cookieHeader = event.headers.cookie ?? event.headers.Cookie;
  if (!cookieHeader) {
    return undefined;
  }

  const parts = cookieHeader.split(";").map((part) => part.trim());
  const pair = parts.find((part) => part.startsWith("paywallm_session="));
  return pair?.slice("paywallm_session=".length);
}

async function bodyJson(
  event: APIGatewayProxyEventV2,
  allowEmpty = false,
): Promise<JsonRecord> {
  if (!event.body) {
    if (allowEmpty) {
      return {};
    }
    throw new Error("missing_body");
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(raw) as JsonRecord;
}

async function safeBodyJson(
  event: APIGatewayProxyEventV2,
): Promise<JsonRecord | undefined> {
  try {
    return await bodyJson(event, true);
  } catch {
    return undefined;
  }
}

function randomNumericCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function buildUserId(): string {
  return "usr_" + randomBytes(12).toString("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(...parts: string[]): string {
  return parts.join("#");
}

function ttlFromNow(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function nowIso(): string {
  return new Date().toISOString();
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readQueryParam(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const value = event.queryStringParameters?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readQueryParams(event: APIGatewayProxyEventV2): URLSearchParams {
  return new URLSearchParams(event.rawQueryString ?? "");
}

function previewParam(params: URLSearchParams, name: string): string | undefined {
  const value =
    params.get(name) ??
    params.get(name.replaceAll("-", "_")) ??
    params.get(name.replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
  return value && value.length > 0 ? value : undefined;
}

function readPreviewBoolean(
  params: URLSearchParams,
  name: string,
  fallback = false,
): boolean {
  const value = previewParam(params, name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function readPreviewPrices(params: URLSearchParams): AppPrice[] {
  const specs = params.getAll("price");
  if (specs.length === 0) {
    return [
      parseCliPriceFlag("managed:subscription:month:15:metered:1000:25:1299"),
      parseCliPriceFlag("byok:subscription:month:700"),
    ];
  }

  return specs.map((spec) => parseCliPriceFlag(spec));
}

function parseAppBranding(
  value: unknown,
  fallbackName: string,
  existing?: AppBranding,
): AppBranding {
  if (value === undefined) {
    return (
      existing ?? {
        appName: fallbackName,
        primaryColor: "#1f6feb",
        accentColor: "#0f172a",
        preferredTheme: "system",
        allowedOrigins: [],
      }
    );
  }

  const row = typeof value === "object" && value && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const copyRow =
    typeof row.copy === "object" && row.copy && !Array.isArray(row.copy)
      ? (row.copy as Record<string, unknown>)
      : {};
  const copy = {
    heroSubtitle: textOrUndefined(copyRow.heroSubtitle) ?? existing?.copy?.heroSubtitle,
    accessSubtitle: textOrUndefined(copyRow.accessSubtitle) ?? existing?.copy?.accessSubtitle,
    plansSubtitle: textOrUndefined(copyRow.plansSubtitle) ?? existing?.copy?.plansSubtitle,
    byokSubtitle: textOrUndefined(copyRow.byokSubtitle) ?? existing?.copy?.byokSubtitle,
    managedSubscriptionLabel:
      textOrUndefined(copyRow.managedSubscriptionLabel) ?? existing?.copy?.managedSubscriptionLabel,
    byokSubscriptionLabel: textOrUndefined(copyRow.byokSubscriptionLabel) ?? existing?.copy?.byokSubscriptionLabel,
    tokenExplanation: textOrUndefined(copyRow.tokenExplanation) ?? existing?.copy?.tokenExplanation,
    tokenHelpUrl: textOrUndefined(copyRow.tokenHelpUrl) ?? existing?.copy?.tokenHelpUrl,
    tokenHelpLabel: textOrUndefined(copyRow.tokenHelpLabel) ?? existing?.copy?.tokenHelpLabel,
  };
  const hasCopy = Object.values(copy).some((value) => value !== undefined);

  return AppBrandingSchema.parse({
    appName: textOrUndefined(row.appName) ?? existing?.appName ?? fallbackName,
    logoUrl: textOrUndefined(row.logoUrl) ?? existing?.logoUrl,
    primaryColor: textOrUndefined(row.primaryColor) ?? existing?.primaryColor ?? "#1f6feb",
    accentColor: textOrUndefined(row.accentColor) ?? existing?.accentColor ?? "#0f172a",
    supportUrl: textOrUndefined(row.supportUrl) ?? existing?.supportUrl,
    legalText: textOrUndefined(row.legalText) ?? existing?.legalText,
    preferredTheme: textOrUndefined(row.preferredTheme) ?? existing?.preferredTheme ?? "system",
    allowedOrigins:
      Array.isArray(row.allowedOrigins)
        ? row.allowedOrigins
        : existing?.allowedOrigins ?? [],
    copy: hasCopy ? copy : undefined,
  });
}

function buildPaywallCsp(allowedOrigins: string[]): string {
  const frameAncestors = allowedOrigins.length > 0 ? ["'self'", ...allowedOrigins].join(" ") : "'self'";
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

async function createStripeBackedPrice(input: {
  appId: string;
  appName: string;
  stripeProductId?: string;
  price: AppPrice;
}): Promise<AppPrice> {
  if (isFreeByokPrice(input.price)) {
    return {
      ...input.price,
      billedUnitAmountUsd: 0,
      stripePriceId: undefined,
      stripeMeterId: undefined,
      meterEventName: undefined,
    };
  }

  let stripeMeterId: string | undefined;
  let meterEventName: string | undefined;
  let stripeBasePriceId: string | undefined;

  if (input.price.billingScheme === "metered") {
    const meter = await stripe.billing.meters.create({
      display_name: `${input.appName} ${input.price.lookupKey} usage`,
      event_name: buildMeterEventName(input.appId, input.price.lookupKey),
      default_aggregation: {
        formula: "sum",
      },
      customer_mapping: {
        event_payload_key: "stripe_customer_id",
        type: "by_id",
      },
      value_settings: {
        event_payload_key: input.price.meterAggregationKey ?? "llm_total_tokens",
      },
    });

    stripeMeterId = meter.id;
    meterEventName = meter.event_name;
  }

  const stripePrice = await stripe.prices.create({
    product: input.stripeProductId,
    unit_amount: billedUnitAmount(input.price),
    currency: "usd",
    recurring:
      input.price.type === "subscription"
        ? {
            interval: input.price.interval ?? "month",
            usage_type: input.price.billingScheme === "metered" ? "metered" : "licensed",
            meter: stripeMeterId,
          }
        : undefined,
    transform_quantity:
      input.price.billingScheme === "metered" && input.price.includedUsageUnits
        ? {
            divide_by: input.price.includedUsageUnits,
            round: "up",
          }
        : undefined,
    metadata: {
      appId: input.appId,
      lookupKey: input.price.lookupKey,
      mode: input.price.mode,
      billingType: input.price.type,
      billingScheme: input.price.billingScheme,
      includedUsageUnits: String(input.price.includedUsageUnits ?? ""),
      billingPremiumPercent: String(input.price.billingPremiumPercent ?? ""),
      baseSubscriptionAmountUsd: String(input.price.baseSubscriptionAmountUsd ?? ""),
    },
  });

  if (
    input.price.type === "subscription" &&
    input.price.billingScheme === "metered" &&
    typeof input.price.baseSubscriptionAmountUsd === "number" &&
    input.price.baseSubscriptionAmountUsd > 0
  ) {
    const basePrice = await stripe.prices.create({
      product: input.stripeProductId,
      unit_amount: input.price.baseSubscriptionAmountUsd,
      currency: "usd",
      recurring: {
        interval: input.price.interval ?? "month",
        usage_type: "licensed",
      },
      metadata: {
        appId: input.appId,
        lookupKey: input.price.lookupKey,
        mode: input.price.mode,
        billingType: input.price.type,
        billingScheme: input.price.billingScheme,
        role: "base_subscription",
      },
    });
    stripeBasePriceId = basePrice.id;
  }

  return {
    ...input.price,
    stripePriceId: stripePrice.id,
    stripeBasePriceId,
    billedUnitAmountUsd: billedUnitAmount(input.price),
    stripeMeterId,
    meterEventName,
  };
}

async function maybeRecordManagedUsage(input: {
  appId: string;
  email: string;
  lookupKey: string;
  stripeCustomerId?: string;
  price: AppPrice;
  mode: Mode;
  provider: Provider;
  model: string;
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;
}): Promise<void> {
  if (input.mode !== "managed") {
    return;
  }

  if (input.price.billingScheme !== "metered") {
    return;
  }

  const totalTokens = input.usage?.totalTokens ?? mergeUsageTotals(input.usage);
  if (!totalTokens || totalTokens <= 0) {
    return;
  }

  const now = nowIso();
  const billedUnits = input.price.includedUsageUnits
    ? Math.ceil(totalTokens / input.price.includedUsageUnits)
    : totalTokens;

  const requestId = randomToken();
  const usageKey = key("USAGE", input.appId, input.email, requestId);

  await ddb.send(
    new PutCommand({
      TableName: env.tableName,
      Item: {
        pk: usageKey,
        sk: usageKey,
        gsi1pk: key("APP", input.appId),
        gsi1sk: key("USAGE", input.email, now),
        appId: input.appId,
        email: input.email,
        provider: input.provider,
        model: input.model,
        lookupKey: input.lookupKey,
        meterEventName: input.price.meterEventName,
        tokenCount: totalTokens,
        billedUnits,
        reportedToStripe: true,
        reportedAt: now,
        billingSource: "stripe_ai_gateway",
        stripeCustomerId: input.stripeCustomerId,
        createdAt: now,
      },
    }),
  );
}

function mergeUsageTotals(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }

  if (typeof usage.totalTokens === "number") {
    return usage.totalTokens;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const total = inputTokens + outputTokens;
  return total > 0 ? total : undefined;
}

function requireMembershipPrice(app: AppRecord, membership: MembershipRecord): AppPrice {
  if (!membership.lookupKey || !membership.mode || !membership.billingType || !membership.billingScheme) {
    throw new Error("invalid_membership");
  }

  const price = app.prices.find((entry) => entry.lookupKey === membership.lookupKey);
  if (!price) {
    throw new Error("membership_price_not_found");
  }

  if (
    price.mode !== membership.mode ||
    price.type !== membership.billingType ||
    price.billingScheme !== membership.billingScheme
  ) {
    throw new Error("membership_price_mismatch");
  }

  return price;
}

function assertUniqueLookupKeys(prices: AppPrice[]): void {
  const seen = new Set<string>();
  for (const price of prices) {
    if (seen.has(price.lookupKey)) {
      throw new Error("duplicate_lookup_key");
    }
    seen.add(price.lookupKey);
  }
}

function isConditionalWriteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "ConditionalCheckFailedException",
  );
}

function buildMeterEventName(appId: string, lookupKey: string): string {
  return `paywallm_${slugForStripe(appId)}_${slugForStripe(lookupKey)}_${randomBytes(4).toString("hex")}`;
}

function slugForStripe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "app";
}

function renderPaywallHtml(input: {
  app: AppRecord;
  embed: boolean;
  prefillEmail: string;
  successUrl: string;
  cancelUrl: string;
  returnUrl: string;
  checkoutState: string;
  sessionTransport: SessionTransport;
  preview?: {
    enabled: boolean;
    email: string;
    paid: boolean;
    mode: Mode;
  };
}): string {
  const copy = input.app.branding.copy;
  const hasMeteredPlan = input.app.prices.some((price) => price.billingScheme === "metered");
  const tokenHelpLabel = copy?.tokenHelpLabel ?? "Learn more";
  const tokenHelpHtml =
    hasMeteredPlan && (copy?.tokenExplanation || copy?.tokenHelpUrl)
      ? `<div class="subtle" style="margin-top:10px;">${
          copy?.tokenExplanation ? escapeHtml(copy.tokenExplanation) : ""
        }${
          copy?.tokenHelpUrl
            ? `${copy?.tokenExplanation ? " " : ""}<a href="${escapeHtml(copy.tokenHelpUrl)}" target="_blank" rel="noreferrer">${escapeHtml(tokenHelpLabel)}</a>`
            : ""
        }</div>`
      : "";
  const bootstrap = JSON.stringify({
    appId: input.app.appId,
    branding: input.app.branding,
    prices: input.app.prices,
    embed: input.embed,
    prefillEmail: input.prefillEmail,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    returnUrl: input.returnUrl,
    checkoutState: input.checkoutState,
    sessionTransport: input.sessionTransport,
    preview: input.preview,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.app.branding.appName)}</title>
    <style>
      :root {
        --primary: ${input.app.branding.primaryColor};
        --accent: ${input.app.branding.accentColor};
        --bg: #f6f7fb;
        --surface: #ffffff;
        --text: #101828;
        --muted: #5b6474;
        --border: rgba(16, 24, 40, 0.1);
      }
      @media (prefers-color-scheme: dark) {
        :root[data-theme="system"] {
          --bg: #0b1220;
          --surface: #111a2b;
          --text: #f8fafc;
          --muted: #c1cad8;
          --border: rgba(255, 255, 255, 0.12);
        }
      }
      :root[data-theme="dark"] {
        --bg: #0b1220;
        --surface: #111a2b;
        --text: #f8fafc;
        --muted: #c1cad8;
        --border: rgba(255, 255, 255, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, color-mix(in srgb, var(--primary) 16%, transparent), transparent 32%),
          linear-gradient(180deg, var(--bg), color-mix(in srgb, var(--bg) 82%, var(--accent)));
        color: var(--text);
      }
      .shell {
        min-height: 100vh;
        padding: ${input.embed ? "12px" : "28px"};
        display: grid;
        place-items: center;
      }
      .panel {
        width: 100%;
        max-width: 880px;
        background: color-mix(in srgb, var(--surface) 94%, transparent);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
        overflow: hidden;
      }
      .hero {
        padding: 24px;
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--primary) 88%, white), color-mix(in srgb, var(--accent) 84%, white));
        color: white;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .brand img {
        width: 52px;
        height: 52px;
        border-radius: 12px;
        object-fit: cover;
        background: rgba(255,255,255,0.16);
      }
      .hero h1 {
        margin: 0;
        font-size: ${input.embed ? "28px" : "34px"};
        line-height: 1.05;
      }
      .hero p {
        margin: 12px 0 0;
        max-width: 56ch;
        opacity: 0.94;
      }
      .hero-actions {
        margin-top: 16px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .content {
        display: grid;
        gap: 18px;
        padding: 20px 20px 18px;
      }
      .step {
        display: grid;
        gap: 12px;
        padding-bottom: 16px;
      }
      .step:last-of-type {
        padding-bottom: 0;
      }
      .step-head {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .step h2 {
        margin: 0;
        font-size: 18px;
      }
      #plansStep .step-head h2 {
        margin-bottom: 8px;
      }
      #plansStep .step-head .subtle {
        margin-bottom: 8px;
      }
      .subtle {
        color: var(--muted);
        font-size: 14px;
      }
      .status {
        font-size: 14px;
        padding: 0 2px;
      }
      .status:empty {
        display: none;
      }
      .callout {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px 16px;
        background: color-mix(in srgb, var(--primary) 8%, var(--surface));
      }
      .callout h3 {
        margin: 0 0 6px;
        font-size: 15px;
      }
      .callout p {
        margin: 0;
        font-size: 14px;
        color: var(--muted);
      }
      .callout-actions {
        margin-top: 12px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .row, form {
        display: grid;
        gap: 10px;
      }
      .inline {
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
      }
      @media (max-width: 640px) {
        .inline {
          grid-template-columns: 1fr;
        }
      }
      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      label {
        font-size: 13px;
        font-weight: 600;
      }
      input, select {
        width: 100%;
        padding: 12px 13px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--surface) 96%, transparent);
        color: var(--text);
      }
      button {
        border: 0;
        border-radius: 12px;
        padding: 12px 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .primary {
        background: var(--primary);
        color: white;
      }
      .secondary {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        color: var(--text);
        border: 1px solid var(--border);
      }
      .ghost {
        background: transparent;
        color: white;
        border: 1px solid rgba(255,255,255,0.35);
      }
      .plans {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      .plan {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        position: relative;
      }
      .plan.active {
        border-color: color-mix(in srgb, var(--primary) 44%, var(--border));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 28%, transparent);
      }
      .price {
        font-size: 28px;
        font-weight: 800;
      }
      .price-subline {
        margin-top: -4px;
        min-height: 16px;
      }
      .price-subline.placeholder {
        visibility: hidden;
      }
      .plan-select {
        margin-top: auto;
      }
      .byok-inline {
        display: grid;
        gap: 10px;
        margin-top: 8px;
        padding-top: 4px;
      }
      .account-actions {
        margin-top: 4px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .auth-inline {
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      .auth-link {
        color: var(--primary);
        font-size: 14px;
        text-decoration: underline;
        cursor: pointer;
      }
      .plan-badge {
        position: absolute;
        top: 10px;
        right: 10px;
        font-size: 11px;
        font-weight: 700;
        color: color-mix(in srgb, var(--primary) 82%, var(--text));
        background: color-mix(in srgb, var(--primary) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
        border-radius: 999px;
        padding: 4px 8px;
      }
      .tiny {
        font-size: 12px;
        color: var(--muted);
      }
      .hidden {
        display: none !important;
      }
      .trust {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--muted);
      }
      .pill {
        border-radius: 999px;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--primary) 10%, transparent);
      }
      a {
        color: inherit;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="panel" id="panel">
        <section class="hero">
          <div class="brand">
            ${input.app.branding.logoUrl ? `<img src="${escapeHtml(input.app.branding.logoUrl)}" alt="${escapeHtml(input.app.branding.appName)} logo">` : ""}
            <div>
              <h1>${escapeHtml(input.app.branding.appName)}</h1>
              <p>${escapeHtml(
                copy?.heroSubtitle ??
                  `Sign in to ${input.app.branding.appName}.`,
              )}</p>
            </div>
          </div>
          <div class="hero-actions">
            ${input.embed ? '<button class="ghost" id="closeButton" type="button">Close</button>' : ""}
            ${input.app.branding.supportUrl ? `<a class="ghost" href="${escapeHtml(input.app.branding.supportUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;display:inline-flex;align-items:center;">Support</a>` : ""}
          </div>
        </section>
        <section class="content">
          <div id="status" class="status" aria-live="polite"></div>
          <div id="returnGuidance" class="callout hidden">
            <h3 id="returnGuidanceTitle">Return to your app</h3>
            <p id="returnGuidanceBody"></p>
            <div class="callout-actions">
              <a id="returnLink" class="secondary hidden" href="#" style="text-decoration:none;display:inline-flex;align-items:center;">Return to app</a>
            </div>
          </div>
          <section class="step" id="signInStep">
            <div class="step-head" id="authHeader">
              <div>
                <h2 id="authTitle">Sign In</h2>
                <div class="subtle" id="authSubtitle">${escapeHtml(copy?.accessSubtitle ?? "Use your email to get a sign-in code.")}</div>
              </div>
            </div>
            <form id="startForm" class="inline">
              <div class="row">
                <label for="email">Email</label>
                <input id="email" type="email" autocomplete="email" required />
              </div>
              <button class="primary" type="submit">Send Code</button>
            </form>
            <form id="verifyForm" class="hidden inline">
              <div class="row">
                <label for="code">Code</label>
                <input id="code" inputmode="numeric" pattern="[0-9]*" required />
              </div>
              <div class="account-actions">
                <button class="primary" type="submit">Verify</button>
                <button class="secondary" id="resendCodeButton" type="button">Resend code</button>
              </div>
            </form>
            <div id="signedInRow" class="hidden auth-inline">
              <div id="signedInNote" class="subtle"></div>
              <a id="logoutLink" class="auth-link" href="#">Log out</a>
            </div>
          </section>
          <section class="step hidden" id="plansStep">
            <div class="step-head">
              <div>
                <h2>Choose plan</h2>
                <div class="subtle">${escapeHtml(copy?.plansSubtitle ?? "Pick the plan that matches how you want to pay.")}</div>
              </div>
            </div>
            <div id="plans" class="plans"></div>
            ${tokenHelpHtml}
          </section>
          <div class="trust">
            <span>Payments handled by Stripe</span>
            ${input.app.branding.legalText ? `<span>${escapeHtml(input.app.branding.legalText)}</span>` : ""}
          </div>
        </section>
      </div>
    </div>
    <script>
      const bootstrap = ${bootstrap};
      const storageKey = "paywallmSessionToken:" + bootstrap.appId;
      const usesTokenTransport = bootstrap.sessionTransport === "token" || bootstrap.sessionTransport === "both";
      const usesCookieTransport = bootstrap.sessionTransport === "cookie" || bootstrap.sessionTransport === "both";
      const state = {
        email: bootstrap.prefillEmail || "",
        token: usesTokenTransport ? (sessionStorage.getItem(storageKey) || "") : "",
        me: null,
      };

      const statusNode = document.getElementById("status");
      const startForm = document.getElementById("startForm");
      const verifyForm = document.getElementById("verifyForm");
      const signedInRow = document.getElementById("signedInRow");
      const signedInNote = document.getElementById("signedInNote");
      const authHeader = document.getElementById("authHeader");
      const authTitle = document.getElementById("authTitle");
      const authSubtitle = document.getElementById("authSubtitle");
      const plansStep = document.getElementById("plansStep");
      const plansNode = document.getElementById("plans");
      const emailInput = document.getElementById("email");
      const codeInput = document.getElementById("code");
      const logoutLink = document.getElementById("logoutLink");
      const resendCodeButton = document.getElementById("resendCodeButton");
      const returnGuidance = document.getElementById("returnGuidance");
      const returnGuidanceTitle = document.getElementById("returnGuidanceTitle");
      const returnGuidanceBody = document.getElementById("returnGuidanceBody");
      const returnLink = document.getElementById("returnLink");

      document.documentElement.dataset.theme = bootstrap.branding.preferredTheme;
      emailInput.value = state.email;

      function emit(type, payload) {
        if (!bootstrap.embed || window.parent === window) return;
        window.parent.postMessage({ source: "paywallm", type, payload: payload || {} }, "*");
      }

      function isAllowedOrigin(origin) {
        return bootstrap.branding.allowedOrigins.includes(origin);
      }

      function setStatus(message, isError) {
        statusNode.textContent = message || "";
        statusNode.style.color = isError ? "#b42318" : "";
        emit("resize", { height: document.documentElement.scrollHeight });
      }

      function renderReturnGuidance() {
        if (!returnGuidance || !returnGuidanceTitle || !returnGuidanceBody || !returnLink) {
          return;
        }

        const hasReturnUrl = Boolean(bootstrap.returnUrl);
        const checkoutState = bootstrap.checkoutState;
        const show = hasReturnUrl || checkoutState === "success" || checkoutState === "cancel";
        returnGuidance.classList.toggle("hidden", !show);
        if (!show) {
          return;
        }

        if (checkoutState === "success") {
          returnGuidanceTitle.textContent = "Purchase complete";
          returnGuidanceBody.textContent = hasReturnUrl
            ? "Your purchase is complete. Return to your app to continue."
            : "Your purchase is complete. You can close this page and return to your app.";
        } else if (checkoutState === "cancel") {
          returnGuidanceTitle.textContent = "Checkout canceled";
          returnGuidanceBody.textContent = hasReturnUrl
            ? "No charge was made. Return to your app when you're ready."
            : "No charge was made. You can close this page and return to your app.";
        } else {
          returnGuidanceTitle.textContent = "Return to your app";
          returnGuidanceBody.textContent = "After you finish here, head back to your app to continue.";
        }

        if (hasReturnUrl) {
          returnLink.href = bootstrap.returnUrl;
          returnLink.classList.remove("hidden");
        } else {
          returnLink.classList.add("hidden");
          returnLink.removeAttribute("href");
        }
      }

      async function api(path, method, body, useAuth) {
        if (bootstrap.preview && bootstrap.preview.enabled) {
          throw new Error("Preview mode: action disabled.");
        }
        const headers = { "content-type": "application/json" };
        if (useAuth && state.token) {
          headers.authorization = "Bearer " + state.token;
        }
        const response = await fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: usesCookieTransport ? "same-origin" : "omit",
        });
        const text = await response.text();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (!response.ok) {
          throw new Error(parsed && parsed.error ? parsed.error : "request_failed");
        }
        return parsed;
      }

      function formatPrice(price) {
        if (price.mode === "byok" && price.type === "one_time" && price.billingScheme === "flat" && price.unitAmountUsd === 0) {
          return "Free";
        }
        const amount =
          typeof price.billedUnitAmountUsd === "number"
            ? price.billedUnitAmountUsd
            : typeof price.unitAmountUsd === "number"
              ? price.unitAmountUsd
              : 0;
        const dollars = "$" + (amount / 100).toFixed(2);
        if (price.billingScheme === "metered" && price.includedUsageUnits) {
          const usagePart = dollars + " per " + price.includedUsageUnits.toLocaleString() + " tokens";
          if (typeof price.baseSubscriptionAmountUsd === "number" && price.baseSubscriptionAmountUsd > 0) {
            return usagePart + " + $" + (price.baseSubscriptionAmountUsd / 100).toFixed(2) + "/" + (price.interval || "month");
          }
          return usagePart;
        }
        if (price.type === "subscription") {
          return dollars + "/" + (price.interval || "month");
        }
        return dollars + " one-time";
      }

      function formatManagedMeteredTokenLine(price) {
        if (price.mode !== "managed" || price.billingScheme !== "metered" || !price.includedUsageUnits) {
          return undefined;
        }
        const amount =
          typeof price.billedUnitAmountUsd === "number"
            ? price.billedUnitAmountUsd
            : typeof price.unitAmountUsd === "number"
              ? price.unitAmountUsd
              : 0;
        return "Plus $" + (amount / 100).toFixed(2) + " per " + price.includedUsageUnits.toLocaleString() + " tokens";
      }

      function renderPlans() {
        plansNode.innerHTML = "";
        const membership = state.me && state.me.membership;
        for (const price of bootstrap.prices) {
          const plan = document.createElement("div");
          plan.className = "plan";
          const isActivePlan = Boolean(
            membership &&
            membership.paid &&
            membership.lookupKey === price.lookupKey,
          );
          if (isActivePlan) {
            plan.classList.add("active");
          }
          const title = document.createElement("div");
          title.innerHTML = "<strong>" + escapeHtmlJs(price.mode === "byok" ? "Use Your Own Key" : "All Included") + "</strong>";
          const amount = document.createElement("div");
          amount.className = "price";
          const meteredTokenLine = formatManagedMeteredTokenLine(price);
          const hasBaseSubscriptionAmount = typeof price.baseSubscriptionAmountUsd === "number" && price.baseSubscriptionAmountUsd > 0;
          if (meteredTokenLine && hasBaseSubscriptionAmount) {
            amount.textContent = "$" + (price.baseSubscriptionAmountUsd / 100).toFixed(2) + "/" + (price.interval || "month");
          } else {
            amount.textContent = formatPrice(price);
          }
          const amountSubline = document.createElement("div");
          amountSubline.className = "tiny price-subline";
          if (meteredTokenLine && hasBaseSubscriptionAmount) {
            amountSubline.textContent = meteredTokenLine;
          } else {
            amountSubline.textContent = "-";
            amountSubline.classList.add("placeholder");
          }
          const meta = document.createElement("div");
          meta.className = "tiny";
          if (price.billingScheme === "metered") {
            meta.textContent = "We'll provide the AI agent";
          } else if (price.type === "subscription") {
            meta.textContent =
              price.mode === "byok"
                ? (bootstrap.branding.copy && bootstrap.branding.copy.byokSubscriptionLabel) || "Provide your own agent API key"
                : (bootstrap.branding.copy && bootstrap.branding.copy.managedSubscriptionLabel) || "Billed automatically";
          } else {
            meta.textContent = "One-time payment";
          }
          if (isActivePlan && price.mode === "byok") {
            meta.classList.add("hidden");
          }

          if (isActivePlan) {
            const badge = document.createElement("div");
            badge.className = "plan-badge";
            badge.textContent = "Current Plan";
            plan.appendChild(badge);
          }

          plan.append(title, amount, amountSubline, meta);

          if (!isActivePlan) {
            const button = document.createElement("button");
            button.className = "primary plan-select";
            button.type = "button";
            button.textContent = membership && membership.paid ? "Switch Plan" : "Select";
            button.addEventListener("click", () => startCheckout(price.lookupKey));
            plan.appendChild(button);
          }

          const isActiveByok = Boolean(isActivePlan && membership && membership.mode === "byok");
          if (isActiveByok) {
            const form = document.createElement("form");
            form.className = "byok-inline";
            form.innerHTML =
              '<div class="split">' +
                '<div class="row">' +
                  "<label>AI Provider</label>" +
                  '<select name="provider">' +
                    '<option value="openai">OpenAI</option>' +
                    '<option value="anthropic">Anthropic</option>' +
                    '<option value="openrouter">OpenRouter</option>' +
                  "</select>" +
                "</div>" +
                '<div class="row">' +
                  '<label data-api-key-label>OpenAI API Key</label>' +
                  '<input name="apiKey" type="password" autocomplete="off" required />' +
                "</div>" +
              "</div>" +
              '<button class="primary" type="submit" disabled>Set API Key</button>';
            const providerInput = form.querySelector("select[name=provider]");
            const apiKeyInput = form.querySelector("input[name=apiKey]");
            const apiKeyLabel = form.querySelector("label[data-api-key-label]");
            const submitButton = form.querySelector("button[type=submit]");
            const providerLabelByValue = {
              openai: "OpenAI",
              anthropic: "Anthropic",
              openrouter: "OpenRouter",
            };
            function refreshByokFormState() {
              if (!providerInput || !apiKeyInput || !apiKeyLabel || !submitButton) return;
              const providerName = providerLabelByValue[providerInput.value] || "Provider";
              apiKeyLabel.textContent = providerName + " API Key";
              submitButton.disabled = apiKeyInput.value.trim().length === 0;
            }
            if (providerInput) {
              providerInput.addEventListener("change", refreshByokFormState);
            }
            if (apiKeyInput) {
              apiKeyInput.addEventListener("input", refreshByokFormState);
            }
            refreshByokFormState();
            form.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!providerInput || !apiKeyInput || !submitButton) return;
              if (apiKeyInput.value.trim().length === 0) return;
              try {
                submitButton.disabled = true;
                await api("/v1/apps/" + encodeURIComponent(bootstrap.appId) + "/keys", "POST", {
                  provider: providerInput.value,
                  apiKey: apiKeyInput.value.trim(),
                }, true);
                apiKeyInput.value = "";
                refreshByokFormState();
                setStatus("API key saved.", false);
              } catch (error) {
                setStatus(error.message || "Couldn't save your key. Please try again.", true);
                refreshByokFormState();
              }
            });
            plan.appendChild(form);
          }
          plansNode.appendChild(plan);
        }
      }

      function renderAccount() {
        const signedIn = Boolean(state.me);
        startForm.classList.toggle("hidden", signedIn);
        verifyForm.classList.toggle("hidden", !state.email || signedIn);
        signedInRow.classList.toggle("hidden", !signedIn);
        authHeader.classList.toggle("hidden", signedIn);
        plansStep.classList.toggle("hidden", !signedIn);

        if (!signedIn) {
          authTitle.textContent = "Sign In";
          authSubtitle.textContent = ${JSON.stringify(copy?.accessSubtitle ?? "Use your email to get a sign-in code.")};
          signedInNote.textContent = "";
          renderPlans();
          return;
        }

        authTitle.textContent = "";
        authSubtitle.textContent = "";
        const signedInEmail =
          (state.me.user && state.me.user.profileEmail) ||
          (state.me.session && state.me.session.loginIdentity && state.me.session.loginIdentity.email) ||
          "";
        signedInNote.innerHTML = "Signed in as <strong>" + escapeHtmlJs(signedInEmail) + "</strong>.";
        renderPlans();
      }

      async function sendLoginCode() {
        state.email = emailInput.value.trim();
        if (!state.email) {
          setStatus("Enter your email first.", true);
          return;
        }

        try {
          if (resendCodeButton) {
            resendCodeButton.setAttribute("disabled", "disabled");
          }
          await api("/auth/start", "POST", { appId: bootstrap.appId, email: state.email }, false);
          verifyForm.classList.remove("hidden");
          setStatus("Code sent. Check your email.", false);
          emit("ready", { appId: bootstrap.appId });
        } catch (error) {
          setStatus(error.message || "Something went wrong. Please try again.", true);
        } finally {
          if (resendCodeButton) {
            resendCodeButton.removeAttribute("disabled");
          }
        }
      }

      async function loadMe() {
        if (!usesCookieTransport && !state.token) {
          state.me = null;
          renderAccount();
          return;
        }
        try {
          state.me = await api("/me", "GET", undefined, true);
          renderAccount();
          setStatus("", false);
          emit("auth_success", {
            profileEmail: state.me.user ? state.me.user.profileEmail || null : null,
            loginEmail:
              state.me.session && state.me.session.loginIdentity
                ? state.me.session.loginIdentity.email || null
                : null,
            membership: state.me.membership || null,
          });
        } catch (error) {
          if (usesTokenTransport) {
            sessionStorage.removeItem(storageKey);
          }
          state.token = "";
          state.me = null;
          renderAccount();
        }
      }

      async function startCheckout(lookupKey) {
        try {
          const payload = { lookupKey };
          if (bootstrap.successUrl) payload.successUrl = bootstrap.successUrl;
          if (bootstrap.cancelUrl) payload.cancelUrl = bootstrap.cancelUrl;
          const result = await api("/billing/checkout", "POST", payload, true);
          if (result && result.free) {
            await loadMe();
            setStatus("Free BYOK access enabled. Add your provider key to continue.", false);
            return;
          }
          emit("checkout_started", { lookupKey, sessionId: result.sessionId || "" });
          if (bootstrap.embed && window.top && window.top !== window) {
            window.top.location.href = result.url;
            return;
          }
          window.location.href = result.url;
        } catch (error) {
          setStatus(error.message || "Something went wrong. Please try again.", true);
          emit("error", { message: error.message || "Something went wrong. Please try again." });
        }
      }

      startForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await sendLoginCode();
      });

      verifyForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const result = await api("/auth/verify", "POST", {
            appId: bootstrap.appId,
            email: state.email,
            code: codeInput.value.trim(),
            sessionTransport: bootstrap.sessionTransport,
          }, false);
          state.token = result.sessionToken || "";
          if (usesTokenTransport && state.token) {
            sessionStorage.setItem(storageKey, state.token);
          } else {
            sessionStorage.removeItem(storageKey);
          }
          await loadMe();
        } catch (error) {
          setStatus(error.message || "That code didn't work. Please try again.", true);
        }
      });

      if (resendCodeButton) {
        resendCodeButton.addEventListener("click", async () => {
          await sendLoginCode();
        });
      }

      logoutLink.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          await api("/auth/logout", "POST", {}, true);
        } finally {
          state.token = "";
          state.me = null;
          sessionStorage.removeItem(storageKey);
          state.email = "";
          emailInput.value = "";
          codeInput.value = "";
          verifyForm.classList.add("hidden");
          renderAccount();
          setStatus("Logged out.", false);
        }
      });

      const closeButton = document.getElementById("closeButton");
      if (closeButton) {
        closeButton.addEventListener("click", () => emit("close_requested", {}));
      }

      window.addEventListener("message", (event) => {
        if (!isAllowedOrigin(event.origin)) return;
        const data = event.data || {};
        if (data.type === "prefill_email" && typeof data.email === "string") {
          emailInput.value = data.email;
          state.email = data.email;
        }
        if (data.type === "set_theme" && data.theme && typeof data.theme === "object") {
          if (typeof data.theme.primaryColor === "string") {
            document.documentElement.style.setProperty("--primary", data.theme.primaryColor);
          }
          if (typeof data.theme.accentColor === "string") {
            document.documentElement.style.setProperty("--accent", data.theme.accentColor);
          }
        }
        if (data.type === "close") {
          emit("close_requested", {});
        }
      });

      if (window.ResizeObserver) {
        const observer = new ResizeObserver(() => emit("resize", { height: document.documentElement.scrollHeight }));
        observer.observe(document.body);
      }

      renderPlans();
      renderAccount();
      renderReturnGuidance();
      if (bootstrap.preview && bootstrap.preview.enabled) {
        const previewMode = bootstrap.preview.mode || "managed";
        const previewPrice =
          bootstrap.prices.find((price) => price.mode === previewMode) ||
          bootstrap.prices[0];
        state.me = {
          email: bootstrap.preview.email || "preview@example.com",
          membership: {
            paid: Boolean(bootstrap.preview.paid),
            mode: previewMode,
            lookupKey: previewPrice ? previewPrice.lookupKey : undefined,
            billingType: previewPrice ? previewPrice.type : undefined,
            billingScheme: previewPrice ? previewPrice.billingScheme : undefined,
          },
        };
        renderAccount();
        emit("ready", { appId: bootstrap.appId, height: document.documentElement.scrollHeight, preview: true });
        emit("resize", { height: document.documentElement.scrollHeight });
      } else {
        loadMe().finally(() => {
          emit("ready", { appId: bootstrap.appId, height: document.documentElement.scrollHeight });
          if (bootstrap.checkoutState === "success") {
            emit("checkout_completed", { status: "success" });
          }
          if (bootstrap.checkoutState === "cancel") {
            emit("checkout_completed", { status: "cancel" });
          }
          emit("resize", { height: document.documentElement.scrollHeight });
        });
      }

      function escapeHtmlJs(value) {
        return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] || char));
      }
    </script>
  </body>
</html>`;
}

function renderPaywallBuilderHtml(pathname: string): string {
  const paywallPreviewPath = `${pathname.endsWith("/") ? pathname.slice(0, -1) : pathname}/paywall`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Paywall Preview Builder</title>
    <style>
      :root {
        --bg: #f4f6fa;
        --surface: #ffffff;
        --text: #0f172a;
        --muted: #475569;
        --border: #dbe2ea;
        --primary: #1f6feb;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f7f9fc, #eef2f8);
        color: var(--text);
      }
      .shell {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px 18px 40px;
        display: grid;
        gap: 14px;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 16px;
      }
      h1, h2 { margin: 0; }
      h1 { font-size: 28px; }
      h2 { font-size: 16px; }
      .subtle { color: var(--muted); margin-top: 8px; font-size: 14px; }
      .row { display: grid; gap: 8px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      label { font-size: 12px; font-weight: 700; color: #334155; }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 11px;
        font: inherit;
        color: var(--text);
        background: white;
      }
      textarea { min-height: 88px; resize: vertical; }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      button {
        border: 1px solid var(--border);
        background: white;
        color: var(--text);
        border-radius: 10px;
        padding: 10px 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .primary {
        background: var(--primary);
        color: white;
        border-color: var(--primary);
      }
      .preset { font-size: 13px; }
      .urlbox {
        width: 100%;
        min-height: 120px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
      }
      .footer {
        font-size: 12px;
        color: var(--muted);
      }
      .checks {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .checks label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }
      .checks input[type="checkbox"] {
        width: auto;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <h1>Paywall Preview Builder</h1>
        <div class="subtle">Create a preview URL for <code>${escapeHtml(paywallPreviewPath)}</code> using CLI-equivalent query params.</div>
        <div class="actions">
          <button class="preset" id="presetConsumer" type="button">Preset: Consumer Managed</button>
          <button class="preset" id="presetByok" type="button">Preset: BYOK Friendly</button>
          <button class="preset" id="presetMixed" type="button">Preset: Mixed + Metered</button>
          <button class="preset" id="presetReset" type="button">Reset</button>
        </div>
      </div>

      <div class="card">
        <h2>App + Branding</h2>
        <div class="grid">
          <div class="row"><label for="name">name</label><input id="name" /></div>
          <div class="row"><label for="appName">app-name</label><input id="appName" /></div>
          <div class="row"><label for="logoUrl">logo-url</label><input id="logoUrl" placeholder="https://..." /></div>
          <div class="row"><label for="theme">theme</label><select id="theme"><option value="">(default)</option><option>light</option><option>dark</option><option>system</option></select></div>
          <div class="row"><label for="primaryColor">primary-color</label><input id="primaryColor" placeholder="#1f6feb" /></div>
          <div class="row"><label for="accentColor">accent-color</label><input id="accentColor" placeholder="#0f172a" /></div>
          <div class="row"><label for="supportUrl">support-url</label><input id="supportUrl" placeholder="https://..." /></div>
          <div class="row"><label for="legalText">legal-text</label><input id="legalText" /></div>
        </div>
      </div>

      <div class="card">
        <h2>Copy</h2>
        <div class="grid">
          <div class="row"><label for="heroSubtitle">hero-subtitle</label><input id="heroSubtitle" /></div>
          <div class="row"><label for="accessSubtitle">access-subtitle</label><input id="accessSubtitle" /></div>
          <div class="row"><label for="plansSubtitle">plans-subtitle</label><input id="plansSubtitle" /></div>
          <div class="row"><label for="byokSubtitle">byok-subtitle</label><input id="byokSubtitle" /></div>
          <div class="row"><label for="managedSubscriptionLabel">managed-subscription-label</label><input id="managedSubscriptionLabel" /></div>
          <div class="row"><label for="byokSubscriptionLabel">byok-subscription-label</label><input id="byokSubscriptionLabel" /></div>
          <div class="row"><label for="tokenExplanation">token-explanation</label><input id="tokenExplanation" /></div>
          <div class="row"><label for="tokenHelpUrl">token-help-url</label><input id="tokenHelpUrl" placeholder="https://..." /></div>
          <div class="row"><label for="tokenHelpLabel">token-help-label</label><input id="tokenHelpLabel" /></div>
        </div>
      </div>

      <div class="card">
        <h2>Prices + Preview State</h2>
        <div class="row">
          <label for="prices">price (one per line, same as CLI shorthand)</label>
          <textarea id="prices" placeholder="managed:subscription:month:15:metered:1000:25&#10;byok:subscription:month:700"></textarea>
        </div>
        <div class="grid">
          <div class="row"><label for="previewMode">preview-mode</label><select id="previewMode"><option value="">auto</option><option>managed</option><option>byok</option></select></div>
          <div class="row"><label for="previewEmail">preview-email</label><input id="previewEmail" placeholder="preview@example.com" /></div>
        </div>
        <div class="checks">
          <label><input id="previewPaid" type="checkbox" checked /> preview-paid</label>
          <label><input id="embed" type="checkbox" /> embed</label>
        </div>
      </div>

      <div class="card">
        <h2>Generated URL</h2>
        <textarea class="urlbox" id="previewUrl" readonly></textarea>
        <div class="actions">
          <button class="primary" id="openPreview" type="button">Open Preview</button>
          <button id="copyUrl" type="button">Copy URL</button>
        </div>
        <div class="footer" id="status"></div>
      </div>
    </div>
    <script>
      const previewPath = ${JSON.stringify(paywallPreviewPath)};
      const fields = {
        name: document.getElementById("name"),
        appName: document.getElementById("appName"),
        logoUrl: document.getElementById("logoUrl"),
        theme: document.getElementById("theme"),
        primaryColor: document.getElementById("primaryColor"),
        accentColor: document.getElementById("accentColor"),
        supportUrl: document.getElementById("supportUrl"),
        legalText: document.getElementById("legalText"),
        heroSubtitle: document.getElementById("heroSubtitle"),
        accessSubtitle: document.getElementById("accessSubtitle"),
        plansSubtitle: document.getElementById("plansSubtitle"),
        byokSubtitle: document.getElementById("byokSubtitle"),
        managedSubscriptionLabel: document.getElementById("managedSubscriptionLabel"),
        byokSubscriptionLabel: document.getElementById("byokSubscriptionLabel"),
        tokenExplanation: document.getElementById("tokenExplanation"),
        tokenHelpUrl: document.getElementById("tokenHelpUrl"),
        tokenHelpLabel: document.getElementById("tokenHelpLabel"),
        prices: document.getElementById("prices"),
        previewMode: document.getElementById("previewMode"),
        previewEmail: document.getElementById("previewEmail"),
        previewPaid: document.getElementById("previewPaid"),
        embed: document.getElementById("embed"),
      };

      const previewUrlBox = document.getElementById("previewUrl");
      const status = document.getElementById("status");

      const defaults = {
        name: "Paywall Preview",
        appName: "Paywall Preview",
        logoUrl: "",
        theme: "light",
        primaryColor: "#1f6feb",
        accentColor: "#0f172a",
        supportUrl: "",
        legalText: "",
        heroSubtitle: "",
        accessSubtitle: "",
        plansSubtitle: "",
        byokSubtitle: "",
        managedSubscriptionLabel: "",
        byokSubscriptionLabel: "",
        tokenExplanation: "",
        tokenHelpUrl: "",
        tokenHelpLabel: "",
        prices: "managed:subscription:month:15:metered:1000:25:1299\\nbyok:subscription:month:700",
        previewMode: "",
        previewEmail: "preview@example.com",
        previewPaid: true,
        embed: false,
      };

      const presets = {
        consumer: {
          name: "BrightNotes",
          appName: "BrightNotes",
          theme: "light",
          primaryColor: "#0f766e",
          accentColor: "#0f172a",
          plansSubtitle: "Choose the plan that fits your writing workflow.",
          prices: "managed:subscription:month:1299",
          previewMode: "managed",
          tokenExplanation: "",
          tokenHelpUrl: "",
          tokenHelpLabel: "",
          byokSubtitle: "",
        },
        byok: {
          name: "Prompt Studio",
          appName: "Prompt Studio",
          theme: "dark",
          primaryColor: "#2563eb",
          accentColor: "#0f172a",
          plansSubtitle: "Use managed billing or connect your own provider key.",
          byokSubtitle: "Paste your provider API key from your account dashboard.",
          tokenExplanation: "Tokens are the units used to measure model usage.",
          tokenHelpUrl: "https://platform.openai.com/tokenizer",
          tokenHelpLabel: "Token guide",
          prices: "byok:subscription:month:700\\nmanaged:subscription:month:1500",
          previewMode: "byok",
        },
        mixed: {
          name: "Game Copilot",
          appName: "Game Copilot",
          theme: "system",
          primaryColor: "#7c3aed",
          accentColor: "#111827",
          plansSubtitle: "Start simple, then upgrade as your usage grows.",
          byokSubtitle: "If you choose BYOK, save your key once and we will use it for your requests.",
          tokenExplanation: "Usage-based plans bill by tokens, which count model input and output text.",
          tokenHelpUrl: "https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them",
          tokenHelpLabel: "What is a token?",
          prices: "managed:subscription:month:15:metered:1000:25\\nmanaged:one_time:-:2999\\nbyok:subscription:month:600",
          previewMode: "",
        },
      };

      function setValues(values) {
        for (const [key, value] of Object.entries(values)) {
          if (!(key in fields)) continue;
          const node = fields[key];
          if (node.type === "checkbox") {
            node.checked = Boolean(value);
          } else {
            node.value = value == null ? "" : String(value);
          }
        }
      }

      function toPairs() {
        const pairs = [];
        const add = (key, value) => {
          const text = String(value || "").trim();
          if (text.length > 0) pairs.push([key, text]);
        };

        add("name", fields.name.value);
        add("app-name", fields.appName.value);
        add("logo-url", fields.logoUrl.value);
        add("theme", fields.theme.value);
        add("primary-color", fields.primaryColor.value);
        add("accent-color", fields.accentColor.value);
        add("support-url", fields.supportUrl.value);
        add("legal-text", fields.legalText.value);
        add("hero-subtitle", fields.heroSubtitle.value);
        add("access-subtitle", fields.accessSubtitle.value);
        add("plans-subtitle", fields.plansSubtitle.value);
        add("byok-subtitle", fields.byokSubtitle.value);
        add("managed-subscription-label", fields.managedSubscriptionLabel.value);
        add("byok-subscription-label", fields.byokSubscriptionLabel.value);
        add("token-explanation", fields.tokenExplanation.value);
        add("token-help-url", fields.tokenHelpUrl.value);
        add("token-help-label", fields.tokenHelpLabel.value);

        const lines = fields.prices.value
          .split(/\\r?\\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) pairs.push(["price", line]);

        add("preview-mode", fields.previewMode.value);
        add("preview-email", fields.previewEmail.value);
        pairs.push(["preview-paid", fields.previewPaid.checked ? "1" : "0"]);
        if (fields.embed.checked) pairs.push(["embed", "1"]);
        return pairs;
      }

      function buildUrl() {
        const query = new URLSearchParams();
        for (const [key, value] of toPairs()) {
          query.append(key, value);
        }
        return previewPath + "?" + query.toString();
      }

      function updateUrl() {
        const url = buildUrl();
        previewUrlBox.value = url;
      }

      function applyPreset(name) {
        setValues(defaults);
        if (presets[name]) setValues(presets[name]);
        updateUrl();
      }

      function bindUpdates() {
        for (const node of Object.values(fields)) {
          const eventName = node.type === "checkbox" ? "change" : "input";
          node.addEventListener(eventName, updateUrl);
        }
      }

      document.getElementById("presetConsumer").addEventListener("click", () => applyPreset("consumer"));
      document.getElementById("presetByok").addEventListener("click", () => applyPreset("byok"));
      document.getElementById("presetMixed").addEventListener("click", () => applyPreset("mixed"));
      document.getElementById("presetReset").addEventListener("click", () => {
        setValues(defaults);
        updateUrl();
      });

      document.getElementById("openPreview").addEventListener("click", () => {
        window.open(previewUrlBox.value, "_blank", "noopener,noreferrer");
      });

      document.getElementById("copyUrl").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(previewUrlBox.value);
          status.textContent = "Copied preview URL.";
        } catch {
          status.textContent = "Copy failed. Select and copy manually.";
        }
      });

      bindUpdates();
      setValues(defaults);
      updateUrl();
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid_string");
  }
  return value;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireUserEmail(user: UserRecord, fallback?: string): string {
  const email = user.primaryEmail ?? fallback;
  if (!email) {
    throw new Error("user_email_missing");
  }
  return email;
}

function parseSessionTransport(value: unknown): SessionTransport {
  if (value === undefined || value === "cookie") {
    return "cookie";
  }
  if (value === "token" || value === "both") {
    return value;
  }
  throw new Error("invalid_session_transport");
}

function paywallSessionTransport(value: unknown, embed: boolean): SessionTransport {
  if (value === undefined) {
    return embed ? "token" : "cookie";
  }

  return parseSessionTransport(value);
}

function normalizeEmail(value: unknown): string {
  return text(value).trim().toLowerCase();
}

function must(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function json(
  statusCode: number,
  payload: JsonRecord | LlmRelaySuccessResponse | ApiErrorResponse,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function withCors(
  event: APIGatewayProxyEventV2,
  response: APIGatewayProxyStructuredResultV2,
): APIGatewayProxyStructuredResultV2 {
  const origin = event.headers.origin ?? event.headers.Origin;
  const responseHeaders = { ...(response.headers as Record<string, string> | undefined) };
  const allowedOriginsHeader = responseHeaders["x-paywallm-allowed-origins"];
  delete responseHeaders["x-paywallm-allowed-origins"];
  const allowedOrigins = allowedOriginsHeader
    ? allowedOriginsHeader
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;
  const allowOrigin =
    origin && origin.length > 0
      ? !allowedOrigins || allowedOrigins.includes(origin)
        ? origin
        : undefined
      : allowedOrigins
        ? undefined
        : "*";

  const headers: Record<string, string> = {
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-expose-headers": "set-cookie",
    vary: "Origin",
    ...responseHeaders,
  };

  if (allowOrigin) {
    headers["access-control-allow-origin"] = allowOrigin;
  }

  if (origin && origin.length > 0 && allowOrigin) {
    headers["access-control-allow-credentials"] = "true";
  }

  return {
    ...response,
    headers,
  };
}

function statusForError(message: string): number {
  if (
    message === "missing_body" ||
    message === "invalid_string" ||
    message === "price_not_found" ||
    message === "invalid_limit" ||
    message === "duplicate_lookup_key" ||
    message === "invalid_session_transport"
  ) {
    return 400;
  }

  if (
    message === "missing_byok_provider_key" ||
    message === "managed_provider_unsupported" ||
    message === "missing_stripe_customer" ||
    message === "invalid_membership" ||
    message === "membership_price_not_found" ||
    message === "membership_price_mismatch" ||
    message === "user_email_missing"
  ) {
    return 400;
  }

  if (
    message === "missing_session" ||
    message === "invalid_session" ||
    message === "expired_session" ||
    message === "invalid_code" ||
    message === "expired_code"
  ) {
    return 401;
  }

  if (
    message === "membership_missing" ||
    message === "mode_not_entitled" ||
    message === "not_paid" ||
    message === "session_app_mismatch"
  ) {
    return 403;
  }

  if (message === "app_not_found" || message === "not_found" || message === "user_not_found") {
    return 404;
  }

  if (message === "app_already_exists") {
    return 409;
  }

  if (message === "login_locked" || message === "login_code_recently_sent") {
    return 429;
  }

  if (message.startsWith("provider_error:")) {
    return 502;
  }

  return 500;
}

function billedUnitAmount(price: AppPrice): number {
  if (price.billingScheme !== "metered") {
    return price.unitAmountUsd;
  }

  const premiumPercent = price.billingPremiumPercent ?? 0;
  const multiplier = 1 + premiumPercent / 100;
  return Math.ceil(price.unitAmountUsd * multiplier);
}

function withAllowedOrigins(
  response: APIGatewayProxyStructuredResultV2,
  allowedOrigins: string[] | undefined,
): APIGatewayProxyStructuredResultV2 {
  if (!allowedOrigins) {
    return response;
  }

  return {
    ...response,
    headers: {
      ...(response.headers as Record<string, string> | undefined),
      "x-paywallm-allowed-origins": allowedOrigins.join(","),
    },
  };
}

function isFreeByokPrice(price: AppPrice): boolean {
  return (
    price.mode === "byok" &&
    price.type === "one_time" &&
    price.billingScheme === "flat" &&
    price.unitAmountUsd === 0
  );
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
