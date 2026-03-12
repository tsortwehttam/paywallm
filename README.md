# paywallm

Small AWS-hosted auth + paywall + LLM relay service for apps, games, and websites.

It is designed to stay compact:

- one Lambda handler
- one API Gateway HTTP API
- one DynamoDB table
- Stripe for billing
- SES for email login codes
- KMS for encrypting user-supplied provider keys
- one hosted branded paywall UI at `/p/:appId`

Runtime deploy configuration can live in the repo root `.env`. The admin CLI can also run globally using flags, env vars, or a user config file.

## What Goes In `.env`

Use the checked-in [`.env.example`](/Users/matthew/Code/Personal/paywallm/.env.example) as the source of truth. Copy it to `.env` and fill in real values.

Required for deploy/runtime:

- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `AWS_KMS_KEY_ID`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`
- `SES_FROM_EMAIL`

Runtime toggle:

- `DEV_ECHO_LOGIN_CODE`

Optional deploy/domain config:

- `PAYWALLM_DOMAIN`
- `PAYWALLM_DOMAIN_HOSTED_ZONE`
- `PAYWALLM_PUBLIC_BASE_URL`

CLI convenience:

- `PAYWALLM_API_URL`
- `PAYWALLM_PROFILE`
- `PAYWALLM_CONFIG`

Notes:

- AWS credentials are not stored in `.env` by default. The AWS SDK and SST will use your normal local AWS credentials chain (`aws configure`, `AWS_PROFILE`, SSO, env vars, etc.).
- `PAYWALLM_API_URL` is optional. After a successful deploy, the CLI can also read `.sst/outputs.json` from the current working directory as a last-resort fallback.
- If `DEV_ECHO_LOGIN_CODE=1`, `/auth/start` returns the login code in the API response instead of sending email. That is only for local/dev setup.
- For global CLI use, prefer `~/.config/paywallm/config.json` (or `$XDG_CONFIG_HOME/paywallm/config.json`).
- `PAYWALLM_DOMAIN` lets SST provision the service at a custom hostname such as `auth.mydomain.com` instead of only the default AWS API hostname.
- `PAYWALLM_DOMAIN_HOSTED_ZONE` is optional and lets you pin the Route53 hosted zone SST should use for DNS validation/records when autodetection is not enough.
- `PAYWALLM_PUBLIC_BASE_URL` is optional and overrides the canonical public base URL returned in SST outputs. Leave it blank unless you need a specific externally visible URL.

## Install

```bash
yarn install
cp .env.example .env
```

Fill in `.env`, then verify your AWS credentials are active.

For a global command on your own machine:

```bash
yarn build
npm link
```

That installs a `paywallm` command pointing at your local checkout.

If you are using the source directly without linking, the dev entrypoint remains:

```bash
yarn cli ...
```

## Deploy

Deploy the service:

```bash
yarn deploy
```

Useful related commands:

```bash
yarn dev
yarn test
yarn remove
yarn typecheck
```

Test files live in `test/` and use the `*.test.ts` naming pattern.

What deploy creates:

- API Gateway HTTP API
- one Lambda function serving all routes
- one DynamoDB table for apps, sessions, memberships, login codes, and encrypted BYOK data

After deploy:

- copy the deployed API URL into `PAYWALLM_API_URL` in `.env`, or
- put it in your user config file, or
- leave it blank and let the CLI read `.sst/outputs.json` when you run from the repo

If `PAYWALLM_DOMAIN=auth.mydomain.com` is set before deploy, the hosted paywall and API can live on that subdomain while the user's main product stays on `mydomain.com` or `www.mydomain.com`.

## CLI

The admin endpoints are IAM-protected. The CLI signs requests with your AWS credentials, so only your IAM identity can call them.

Config resolution order for the CLI:

1. command flags such as `--api-url`, `--region`, `--aws-profile`, `--profile`, `--config`
2. environment variables
3. user config file at `~/.config/paywallm/config.json`
4. `.sst/outputs.json` in the current working directory for `apiUrl` only

Example user config:

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
      "apiUrl": "https://your-api-id.execute-api.us-east-1.amazonaws.com",
      "region": "us-east-1",
      "awsProfile": "paywallm-prod"
    }
  }
}
```

For agents and automation, the most explicit no-surprises form is:

```bash
PAYWALLM_API_URL=https://your-api.example.com \
AWS_REGION=us-east-1 \
AWS_PROFILE=paywallm-prod \
paywallm list-apps
```

Current commands:

### `paywallm config show`

Shows the resolved CLI configuration and where each value came from.

```bash
paywallm config show
paywallm config show --profile prod
```

### `paywallm whoami`

Shows the AWS identity the CLI is using.

```bash
paywallm whoami
```

Use this first if you want to confirm which account/role will be allowed to hit the admin API.

### `paywallm list-apps`

Lists all apps known to the service.

```bash
paywallm list-apps
```

### `paywallm add-app <appId> <name> --prices-file ...`

Creates a new app in the service and automatically creates the matching Stripe product and Stripe prices.

```bash
paywallm add-app game-a "Game A" \
  --prices-file ./prices.json \
  --logo-url https://game-a.example.com/logo.png \
  --primary-color '#145af2' \
  --accent-color '#0f172a' \
  --origin https://game-a.example.com
```

Example `prices.json`:

```json
[
  {
    "mode": "byok",
    "type": "one_time",
    "amountCents": 1999
  },
  {
    "mode": "managed",
    "type": "subscription",
    "interval": "month",
    "amountCents": 15,
    "billingScheme": "metered",
    "includedUsageUnits": 1000,
    "billingPremiumPercent": 25,
    "baseSubscriptionAmountUsd": 1299
  }
]
```

Ready-made examples live in [examples/one-time-managed-flat.json](/Users/matthew/Code/Personal/paywallm/examples/one-time-managed-flat.json), [examples/monthly-managed-metered.json](/Users/matthew/Code/Personal/paywallm/examples/monthly-managed-metered.json), [examples/one-time-byok-flat.json](/Users/matthew/Code/Personal/paywallm/examples/one-time-byok-flat.json), [examples/monthly-byok-flat.json](/Users/matthew/Code/Personal/paywallm/examples/monthly-byok-flat.json), and [examples/multi-plan-mixed.json](/Users/matthew/Code/Personal/paywallm/examples/multi-plan-mixed.json).

These intentionally vary:

- `managed` vs `byok`
- `one_time` vs `subscription`
- `flat` vs `metered`
- different price points and managed markup
- single-plan vs multi-plan app setups

The structured file format is the recommended path because each field is explicit and easier to review.

Shorthand is still supported for quick one-off setup:

```text
--price <mode>:<type>:<intervalOrDash>:<amountCents>[:<flatOrMetered>[:<includedUsageUnits>[:<premiumPercent>[:<baseSubscriptionAmountCents>]]]]
```

Fields:

- `mode`: `byok` or `managed`
- `type`: `subscription` or `one_time`
- `intervalOrDash`: `month`, `year`, or `-` for one-time
- `amountCents`: integer amount in cents
- `flatOrMetered`: optional, defaults to `flat`
- `includedUsageUnits`: required only for `metered` prices, for example billed units per `1000` tokens
- `premiumPercent`: optional for `metered`, adds markup to the customer-facing billed unit rate
- `baseSubscriptionAmountCents`: optional for `metered`, adds a fixed recurring base fee to the same subscription

Examples:

- `--price byok:subscription:month:500`
- `--price managed:subscription:year:12000`
- `--price byok:one_time:-:0` (free BYOK: no Stripe checkout, user must add API key)
- `--price byok:one_time:-:1999`
- `--price managed:one_time:-:4999`
- `--price managed:subscription:month:15:metered:1000`
- `--price managed:subscription:month:15:metered:1000:25`
- `--price managed:subscription:month:15:metered:1000:25:1299`

Behavior:

- creates one Stripe Product for the app
- creates one Stripe Price for each paid `--price`
- `byok:one_time:-:0` is treated as a free BYOK entitlement and skips Stripe checkout
- stores the Stripe IDs and paywall branding inside the app record in DynamoDB

Branding flags:

- `--app-name <text>` optional display name override shown on the hosted paywall
- `--logo-url <https-url>`
- `--primary-color <#RRGGBB>`
- `--accent-color <#RRGGBB>`
- `--theme light|dark|system`
- `--support-url <https-url>`
- `--legal-text <text>`
- `--hero-subtitle <text>` custom intro sentence in the hero section
- `--access-subtitle <text>` custom helper text above login
- `--plans-subtitle <text>` custom helper text above plan cards
- `--byok-subtitle <text>` custom helper text in the BYOK key form card
- `--managed-subscription-label <text>` custom plan meta label for managed subscription cards
- `--byok-subscription-label <text>` custom plan meta label for BYOK subscription cards
- `--token-explanation <text>` optional plain-language note shown when metered plans exist
- `--token-help-url <https-url>` optional docs link shown next to token explanation
- `--token-help-label <text>` optional link label (default: `Learn more`)
- `--origin <https-origin>` (repeatable allowlist for iframe embedding)

This is the main way to avoid setting up Stripe pricing in the dashboard manually.

Metered pricing notes:

- `metered` is only valid for `managed` subscription prices
- the stored usage unit is raw total tokens reported from the LLM relay
- `includedUsageUnits` controls how Stripe converts usage into billable units
- `premiumPercent` adds a configurable markup before the Stripe price is created
- example: `managed:subscription:month:15:metered:1000` means `$0.15` per `1000` tokens
- example: `managed:subscription:month:15:metered:1000:25` bills the customer `$0.19` per `1000` tokens (`ceil(15 * 1.25)`)
- example: `managed:subscription:month:15:metered:1000:25:1299` adds `$12.99/month` base fee plus usage charges

### `paywallm update-app <appId> ...`

Updates app metadata and hosted paywall branding without recreating prices.

```bash
paywallm update-app game-a \
  --name "Game A Deluxe" \
  --logo-url https://game-a.example.com/logo.png \
  --primary-color '#145af2' \
  --accent-color '#0f172a' \
  --origin https://game-a.example.com
```

### `paywallm grant <appId> <email> --mode ... --billing ...`

Marks a user as paid for a specific app.

```bash
paywallm grant game-a user@example.com --mode managed --billing subscription
```

Flags:

- `--mode managed|byok` (default: `managed`)
- `--billing subscription|one_time` (default: `one_time`)
- `--scheme flat|metered` (default: `flat`)

This is useful for manual grants, comps, testing, or support cases.

### `paywallm usage <appId> [--email ...] [--limit ...]`

Lists recent metered usage rows recorded for an app.

```bash
paywallm usage game-a --limit 25
paywallm usage game-a --email user@example.com --limit 100
```

Returns recent usage ledger rows including:

- raw token count
- billable units after token bucketing
- billed unit rate in cents
- estimated charge in cents
- whether usage was recorded via Stripe AI Gateway billing

### `paywallm revoke <appId> <email>`

Marks a user as unpaid for a specific app.

```bash
paywallm revoke game-a user@example.com
```

## Creating An App

Typical setup for a new app:

1. Deploy the service with `yarn deploy`.
2. Create the app with `paywallm add-app ...`.
3. Add the service login flow to your app/game/site.
4. Call the billing endpoint from your client when the user chooses a paid plan.
5. Call the LLM relay endpoint using the user session.

Example:

```bash
paywallm add-app game-a "Game A" \
  --prices-file ./prices.json
```

That creates:

- app record for `game-a`
- one Stripe product for `Game A`
- four Stripe prices tied to that app

## User Flow

From the end user perspective, the flow is:

1. They choose to sign in for a specific app.
2. Your client calls `POST /auth/start` with `appId` and `email`.
3. The service sends a login code by email (or echoes it in dev mode).
4. Your client calls `POST /auth/verify` with `appId`, `email`, and `code`.
5. The service creates a session using either cookie transport, token transport, or both.
6. Your client can call `GET /me` to see the user state for that app.
7. If they need paid access, your client calls `POST /billing/checkout` with one of the app's `lookupKey` values.
8. Stripe handles checkout.
9. Stripe webhook updates the user's entitlement record.
10. Your client calls `POST /v1/apps/:appId/llm` to relay model requests using either the user's key or your managed key.

Everything is app-scoped for billing and entitlement, with a stable internal user account behind each login identity:

- one user can have different entitlements in different apps
- one app can offer both `byok` and `managed` prices
- users can store their own provider keys for BYOK mode
- email-code login is the current identity method, but the storage model is ready for future linked identities such as OAuth

## User-Facing API Summary

Implemented public routes:

- `GET /p/:appId`
- `POST /auth/start`
- `POST /auth/verify`
- `POST /auth/logout`
- `GET /me`
- `POST /billing/checkout`
- `POST /billing/portal`
- `POST /stripe/webhook`
- `POST /v1/apps/:appId/keys`
- `POST /v1/apps/:appId/llm`

## Hosted Paywall UI

Each app gets a hosted paywall route:

```text
GET /p/:appId
```

There is also a preview route for copy/branding iteration without creating an app record:

```text
GET /preview/paywall
```

And a helper builder page with presets:

```text
GET /preview
```

`/preview` generates preview URLs for `/preview/paywall`, lets you tune copy/colors/prices, and includes a few starter presets.

`/preview/paywall` accepts query params that mirror CLI branding/price flags (without the `--`), including repeatable `price`:

- `name`, `app-name`, `logo-url`
- `primary-color`, `accent-color`, `theme`
- `support-url`, `legal-text`
- `hero-subtitle`, `access-subtitle`, `plans-subtitle`, `byok-subtitle`
- `managed-subscription-label`, `byok-subscription-label`
- `token-explanation`, `token-help-url`, `token-help-label`
- `price` (repeat): same shorthand as CLI, for example `managed:subscription:month:15:metered:1000:25`

Preview-only query params:

- `preview-paid=1|0` (default `1`)
- `preview-mode=managed|byok` (default: auto)
- `preview-email=user@example.com`

Example:

```text
/preview/paywall?name=Consumer%20App&app-name=Consumer%20App&primary-color=%23145af2&accent-color=%230f172a&theme=light&plans-subtitle=Choose%20your%20plan&token-explanation=Tokens%20measure%20AI%20usage.&token-help-url=https%3A%2F%2Fexample.com%2Ftokens&token-help-label=What%20are%20tokens%3F&price=managed%3Asubscription%3Amonth%3A15%3Ametered%3A1000%3A25&price=byok%3Asubscription%3Amonth%3A700&preview-mode=byok
```

Useful query params:

- `embed=1` renders a tighter iframe-friendly layout
- `email=user@example.com` pre-fills the email field
- `session_transport=cookie|token|both` overrides the paywall auth transport
- `success_url=https://app.example.com/billing/success`
- `cancel_url=https://app.example.com/billing/cancel`
- `return_url=https://app.example.com/account`

The page uses the app's stored branding config for:

- app name
- logo
- primary and accent colors
- support link
- legal footer copy
- paywall copy text for hero/access/plans/BYOK sections
- optional token explanation + token docs link (for metered plans)
- preferred theme
- allowed iframe parent origins

## Embed Contract

For web apps, embed the hosted paywall in an iframe pointed at `/p/:appId?embed=1`.

Recommended:

- set `--origin` values on the app so the page sends a matching `frame-ancestors` CSP
- use `postMessage` from the iframe to resize and observe completion state

Events emitted from the paywall page:

- `ready`
- `resize`
- `auth_success`
- `checkout_started`
- `close_requested`
- `error`

Messages accepted by the paywall page from allowed parent origins:

- `prefill_email`
- `set_theme`
- `close`

## Admin Usage Reporting

There is an IAM-protected usage reporting endpoint for metered managed plans:

```text
GET /admin/apps/:appId/usage
```

Optional query params:

- `email=user@example.com`
- `limit=50`

This returns the recent usage ledger entries written after successful LLM relay calls for that app.
For managed metered plans, these rows represent requests whose usage was recorded through Stripe AI Gateway-backed billing.

## License

MIT. See [LICENSE](/Users/matthew/Code/Personal/paywallm/LICENSE).

## Web App Workflow

### Custom Domain Deployment

The intended production shape is:

- `https://mydomain.com` or `https://www.mydomain.com` for the main product site
- `https://auth.mydomain.com` for Paywallm

That keeps the hosted paywall, auth endpoints, billing routes, and LLM relay on a dedicated subdomain without forcing the customer to move their main site.

Minimal setup:

1. Set `PAYWALLM_DOMAIN=auth.mydomain.com` in `.env`.
2. If needed, set `PAYWALLM_DOMAIN_HOSTED_ZONE=mydomain.com`.
3. Deploy with `yarn deploy`.
4. Point Stripe webhooks at `https://auth.mydomain.com/stripe/webhook`.
5. Set `STRIPE_SUCCESS_URL` and `STRIPE_CANCEL_URL` to pages on `https://mydomain.com` or `https://www.mydomain.com`.
6. Create or update each app with `--origin https://mydomain.com` and/or `--origin https://www.mydomain.com`.

Notes:

- The hosted paywall page at `/p/:appId` uses relative API calls, so when the service is mounted at `auth.mydomain.com`, the UI and API stay same-origin.
- The `paywallm_session` cookie is host-scoped to the Paywallm domain. That is correct for `auth.mydomain.com`; your main site should treat Paywallm as a separate auth/billing surface.
- For embedded iframes and native clients, prefer token transport instead of depending on cross-site cookies.

There are two recommended integration patterns for web apps:

### Option 1: Full-Page Hosted Paywall

Use this when you want the simplest and most reliable flow.

1. Create and brand the app in Paywallm with `paywallm add-app ...` or `paywallm update-app ...`.
2. Add your web origin with one or more `--origin` flags so embedding and parent messaging are restricted to your site.
3. Link users to the hosted paywall route:

```text
https://your-paywall-domain.example.com/p/<appId>
```

4. Optionally pass convenience query params:

```text
/p/<appId>?email=user@example.com&success_url=https%3A%2F%2Fapp.example.com%2Fbilling%2Fsuccess&cancel_url=https%3A%2F%2Fapp.example.com%2Fbilling%2Fcancel&return_url=https%3A%2F%2Fapp.example.com%2Faccount
```

5. The user signs in, completes checkout if needed, and manages BYOK keys on the hosted page.
6. After billing, Stripe redirects the user back to the URLs you supplied (or the default env-based fallback URLs).
7. Your app can then continue using the normal authenticated API flow against Paywallm from the browser or your backend.

This mode avoids iframe layout issues and is the best default choice.

Session behavior for this mode:

- default paywall transport is `cookie`
- `/auth/verify` sets `paywallm_session` and does not need to expose a bearer token to browser JavaScript
- subsequent hosted paywall requests use the cookie automatically

### Option 2: Embedded Iframe Paywall

Use this when you want the paywall inside an in-app modal or settings panel.

1. Create an iframe that points to:

```text
/p/<appId>?embed=1
```

Iframe mode defaults to `session_transport=token` because third-party cookies are not reliable across browsers.

2. If you already know the user email, pass it in the URL or send it after load:

```text
/p/<appId>?embed=1&email=user@example.com
```

3. Listen for `postMessage` events from the iframe:

- `ready`: the paywall has loaded
- `resize`: update iframe height using `payload.height`
- `auth_success`: the user finished login
- `checkout_started`: the paywall is redirecting into Stripe Checkout
- `checkout_completed`: the paywall was opened with a success/cancel checkout state
- `close_requested`: the embedded UI wants to be dismissed
- `error`: show or log an integration error

4. Send messages back to the iframe only from an allowed origin:

- `prefill_email`
- `set_theme`
- `close`

5. When you receive `resize`, update the iframe height so the embedded page fits cleanly.
6. When you receive `checkout_started`, expect the browser to leave the iframe context and go to Stripe Checkout.
7. After Stripe returns to your supplied success or cancel URL, either reopen the iframe or send the user back into your normal app flow.

`auth_success` payload fields:

- `profileEmail`: canonical user-facing email for the account
- `loginEmail`: email used for the current login identity
- `membership`: current membership snapshot

Minimal parent-page sketch:

```html
<iframe
  id="paywallFrame"
  src="https://your-paywall-domain.example.com/p/game-a?embed=1&email=user%40example.com"
  style="width:100%;border:0;"
></iframe>
<script>
  const frame = document.getElementById("paywallFrame");
  window.addEventListener("message", (event) => {
    if (event.origin !== "https://your-paywall-domain.example.com") return;
    const data = event.data || {};
    if (data.source !== "paywallm") return;
    if (data.type === "resize" && data.payload?.height) {
      frame.style.height = data.payload.height + "px";
    }
    if (data.type === "close_requested") {
      frame.remove();
    }
  });

  frame.addEventListener("load", () => {
    frame.contentWindow?.postMessage(
      { type: "prefill_email", email: "user@example.com" },
      "https://your-paywall-domain.example.com",
    );
  });
</script>
```

### Practical Recommendation

- Start with the full-page hosted paywall unless you specifically need inline embedding.
- Use iframe mode for desktop web apps that want a modal-style billing/auth surface.
- Keep your app branding in Paywallm app config instead of rebuilding the paywall UI separately in each product.

### Native App Workflow

Use this for iOS, Android, desktop app shells, or Unity.

1. Call `POST /auth/start`.
2. Call `POST /auth/verify` with `"sessionTransport": "token"`.
3. Store the returned bearer token in the platform secure store.
4. Send `Authorization: Bearer <sessionToken>` on `/me`, `/billing/checkout`, `/billing/portal`, `/v1/apps/:appId/keys`, and `/v1/apps/:appId/llm`.
5. On logout, call `POST /auth/logout` with the same bearer token and clear local storage.

Practical notes:

- do not rely on cookies for native webviews, embedded browsers, or Unity clients
- Stripe Checkout handoff and return should be handled with your platform's normal browser/deep-link flow
- if you present the hosted paywall inside a webview, prefer `session_transport=token`

### `POST /v1/apps/:appId/keys`

This stores a user's encrypted BYOK provider key for a specific app.

Authentication:

- send `Authorization: Bearer <sessionToken>`, or
- use the `paywallm_session` cookie from `/auth/verify` when the session was created with cookie transport

Request body:

```json
{
  "provider": "openrouter",
  "apiKey": "sk-or-v1-..."
}
```

Allowed providers:

- `openai`
- `anthropic`
- `openrouter`

Behavior:

- the raw key is encrypted with AWS KMS
- only the ciphertext is stored in DynamoDB

### `POST /billing/checkout`

Creates a Stripe Checkout session for the authenticated user's current app membership.

Request body:

```json
{
  "lookupKey": "managed_subscription_month_1500",
  "successUrl": "https://game-a.example.com/billing/success",
  "cancelUrl": "https://game-a.example.com/billing/cancel"
}
```

Notes:

- `successUrl` and `cancelUrl` are optional per-request overrides
- if omitted, the service falls back to `STRIPE_SUCCESS_URL` and `STRIPE_CANCEL_URL`

### `POST /billing/portal`

Creates a Stripe Billing Portal session for the authenticated user.

Request body:

```json
{
  "returnUrl": "https://game-a.example.com/account"
}
```

Notes:

- `returnUrl` is optional
- if omitted, the service falls back to `STRIPE_SUCCESS_URL`
- later `mode: "byok"` LLM calls use this stored key

### `POST /v1/apps/:appId/llm`

This is the LLM relay endpoint.

Authentication:

- send `Authorization: Bearer <sessionToken>`, or
- use the `paywallm_session` cookie from `/auth/verify` when the session was created with cookie transport

### `POST /auth/verify`

Verifies an emailed login code and creates a session.

Request body:

```json
{
  "appId": "game-a",
  "email": "user@example.com",
  "code": "123456",
  "sessionTransport": "token"
}
```

`sessionTransport` options:

- `cookie`: sets the `paywallm_session` cookie and does not return `sessionToken`
- `token`: returns `sessionToken` and does not set a cookie
- `both`: sets the cookie and also returns `sessionToken`

Recommended transport by client type:

- full-page web: `cookie`
- iframe embed: `token`
- mobile app / desktop shell / Unity: `token`

### `GET /me`

Returns the current app-scoped session, user, membership, and app state.

Response shape:

```json
{
  "appId": "game-a",
  "user": {
    "userId": "usr_123",
    "profileEmail": "user@example.com"
  },
  "session": {
    "loginIdentity": {
      "type": "email",
      "email": "user@example.com"
    }
  },
  "membership": {},
  "app": {}
}
```

Notes:

- `user.profileEmail` is the user-facing/canonical email for the account
- `session.loginIdentity.email` is the email used for this login flow
- these are the same today for email-code login, but the API is now shaped so future OAuth identities do not require another breaking redesign

Request body:

```json
{
  "mode": "managed",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "messages": [
    {
      "role": "system",
      "content": "You are a concise assistant."
    },
    {
      "role": "user",
      "content": "Write a haiku about rain."
    }
  ],
  "temperature": 0.2,
  "maxOutputTokens": 256,
  "stream": false
}
```

Request fields:

- `mode`: `"managed"` or `"byok"`
- `provider`: `"openai"`, `"anthropic"`, or `"openrouter"`
- `model`: provider-specific model id
- `messages`: array of `{ role, content }` messages
- `role`: `"system"`, `"user"`, or `"assistant"`
- `temperature`: optional number from `0` to `2`
- `maxOutputTokens`: optional positive integer token cap
- `stream`: currently only `false` is accepted

Success response:

```json
{
  "ok": true,
  "provider": "openai",
  "mode": "managed",
  "model": "gpt-4.1-mini",
  "outputText": "Soft rain threads the dusk...",
  "finishReason": "completed",
  "usage": {
    "inputTokens": 24,
    "outputTokens": 18,
    "totalTokens": 42
  },
  "upstream": {}
}
```

Notes:

- `upstream` is the raw parsed JSON returned by the upstream provider.
- The exact shape of `upstream` varies by provider and model API.
- `managed` mode routes through Stripe AI Gateway (`llm.stripe.com`) and requires a Stripe customer on the membership.
- `openrouter` is supported only for `byok` mode.
- `outputText` is the normalized text extracted from the provider response.
- `usage` is normalized when the provider returns token counts.
- The service supports multi-message input, but it does not yet expose tool use or streaming.

Provider notes:

- `managed + openai`: forwarded to Stripe AI Gateway `/responses`
- `managed + anthropic`: forwarded to Stripe AI Gateway `/v1/messages`, with `system` messages folded into the top-level `system` field
- `byok + openai`: forwarded to OpenAI `/v1/responses`
- `byok + anthropic`: forwarded to Anthropic `/v1/messages`
- `byok + openrouter`: forwarded to OpenRouter `/api/v1/chat/completions`

Error response:

```json
{
  "error": "mode_not_entitled"
}
```

Implemented admin routes:

- `POST /admin/apps`
- `GET /admin/apps`
- `PATCH /admin/apps/:appId`
- `POST /admin/apps/:appId/prices`
- `POST /admin/users/:appId/:email/grant`
- `POST /admin/users/:appId/:email/revoke`

## Current Scope

This is an MVP scaffold, not a finished production billing platform.

It already covers:

- email-code auth
- app-scoped sessions
- Stripe Checkout session creation
- Stripe webhook entitlement updates
- app creation with automatic Stripe product/price setup
- BYOK key storage encrypted with KMS
- managed-mode forwarding through Stripe AI Gateway for OpenAI and Anthropic

What still needs hardening before serious production use:

- stricter entitlement validation rules
- a better model for multiple active products/prices per app
- request validation
- usage metering and rate limiting
- deeper audit logging
