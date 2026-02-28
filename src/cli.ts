#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { parseCliPriceFlag } from "./shared.js";

type JsonRecord = Record<string, unknown>;

type StoredConfig = {
  apiUrl?: string;
  region?: string;
  awsProfile?: string;
  defaultProfile?: string;
  profiles?: Record<string, Omit<StoredConfig, "defaultProfile" | "profiles">>;
};

type ConfigContext = {
  apiUrl?: string;
  region?: string;
  awsProfile?: string;
  profile?: string;
  configPath: string;
  sources: {
    apiUrl?: string;
    region?: string;
    awsProfile?: string;
    profile?: string;
  };
};

type CliConfig = {
  apiUrl: string;
  region: string;
  awsProfile?: string;
};

class CliError extends Error {
  code: string;
  details?: JsonRecord;

  constructor(code: string, message: string, details?: JsonRecord) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type BuildConfigContextInput = {
  args: string[];
  env: NodeJS.ProcessEnv;
  configPath: string;
  storedConfig?: StoredConfig;
  repoApiUrl?: string;
};

async function main(): Promise<void> {
  loadProjectDotenv();

  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "config") {
    await configCommand(rest);
    return;
  }

  if (command === "add-app") {
    await addApp(rest);
    return;
  }

  if (command === "list-apps") {
    await callApi("GET", "/admin/apps", undefined, await resolveCliConfig(rest));
    return;
  }

  if (command === "usage") {
    await usage(rest);
    return;
  }

  if (command === "update-app") {
    await updateApp(rest);
    return;
  }

  if (command === "grant") {
    await grant(rest, true);
    return;
  }

  if (command === "revoke") {
    await grant(rest, false);
    return;
  }

  if (command === "whoami") {
    await whoAmI(rest);
    return;
  }

  printHelp();
  process.exit(1);
}

async function configCommand(args: string[]): Promise<void> {
  const [subcommand] = args;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printConfigHelp();
    return;
  }

  if (subcommand === "show") {
    const context = await resolveConfigContext(args.slice(1));
    printJson(context);
    return;
  }

  throw new CliError("INVALID_COMMAND", "Usage: paywallm config show [--profile name] [--config path]");
}

async function addApp(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printAddAppHelp();
    return;
  }

  const [appId, name, ...flags] = args;
  if (!appId || !name) {
    if (!wantsJson(args)) {
      printAddAppHelp();
    }
    throw new CliError("MISSING_ARGUMENTS", "Missing required arguments: <appId> <name>");
  }

  const prices = [
    ...(await readPricesFileFlag(flags)),
    ...readRepeatedFlag(flags, "--price").map((value) => parseCliPriceFlag(value)),
  ];

  if (prices.length === 0) {
    throw new CliError("MISSING_PRICE_INPUT", "Provide at least one price via --prices-file or --price.");
  }

  const payload = {
    appId,
    name,
    branding: readBrandingFlags(name, flags),
    prices,
  };

  await callApi("POST", "/admin/apps", payload, await resolveCliConfig(flags));
}

async function updateApp(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printUpdateAppHelp();
    return;
  }

  const [appId, ...flags] = args;
  if (!appId) {
    if (!wantsJson(args)) {
      printUpdateAppHelp();
    }
    throw new CliError("MISSING_ARGUMENTS", "Missing required argument: <appId>");
  }

  const name = readSingleFlag(flags, "--name");
  const branding = readBrandingFlags(name ?? "", flags, true);
  const payload: JsonRecord = {};

  if (name) {
    payload.name = name;
  }

  if (Object.keys(branding).length > 0) {
    payload.branding = branding;
  }

  if (Object.keys(payload).length === 0) {
    throw new CliError("MISSING_UPDATE_FIELDS", "Provide at least one update field.");
  }

  await callApi("PATCH", `/admin/apps/${encodeURIComponent(appId)}`, payload, await resolveCliConfig(flags));
}

async function usage(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printUsageHelp();
    return;
  }

  const [appId, ...flags] = args;
  if (!appId) {
    if (!wantsJson(args)) {
      printUsageHelp();
    }
    throw new CliError("MISSING_ARGUMENTS", "Missing required argument: <appId>");
  }

  const email = readSingleFlag(flags, "--email");
  const limit = readSingleFlag(flags, "--limit");
  const query = new URLSearchParams();
  if (email) {
    query.set("email", email);
  }
  if (limit) {
    query.set("limit", limit);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  await callApi("GET", `/admin/apps/${encodeURIComponent(appId)}/usage${suffix}`, undefined, await resolveCliConfig(flags));
}

async function readPricesFileFlag(args: string[]): Promise<Array<Record<string, unknown>>> {
  const path = readSingleFlag(args, "--prices-file");
  if (!path) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError("PRICES_FILE_READ_FAILED", `Unable to read prices file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new CliError("INVALID_PRICES_FILE", "--prices-file must point to a JSON array");
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CliError("INVALID_PRICES_FILE", "--prices-file entries must be JSON objects");
    }

    return entry as Record<string, unknown>;
  });
}

async function grant(args: string[], paid: boolean): Promise<void> {
  if (wantsHelp(args)) {
    printGrantHelp(paid);
    return;
  }

  const [appId, email, ...flags] = args;
  if (!appId || !email) {
    if (!wantsJson(args)) {
      printGrantHelp(paid);
    }
    throw new CliError("MISSING_ARGUMENTS", "Missing required arguments: <appId> <email>");
  }

  const mode = readSingleFlag(flags, "--mode") ?? "managed";
  const billingType = readSingleFlag(flags, "--billing") ?? "one_time";
  const billingScheme = readSingleFlag(flags, "--scheme") ?? "flat";

  await callApi(
    "POST",
    `/admin/users/${encodeURIComponent(appId)}/${encodeURIComponent(email)}/${paid ? "grant" : "revoke"}`,
    paid
      ? {
          mode,
          billingType,
          billingScheme,
        }
      : {},
    await resolveCliConfig(flags),
  );
}

async function whoAmI(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printWhoAmIHelp();
    return;
  }

  const config = await resolveCliConfig(args);
  const sts = new STSClient({ region: config.region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  printJson(
    {
      account: identity.Account,
      arn: identity.Arn,
      userId: identity.UserId,
      region: config.region,
      awsProfile: config.awsProfile,
    },
  );
}

async function callApi(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload: JsonRecord | undefined,
  config: CliConfig,
): Promise<void> {
  const endpoint = new URL(path, config.apiUrl);
  const body = payload ? JSON.stringify(payload) : undefined;

  if (config.awsProfile) {
    process.env.AWS_PROFILE = config.awsProfile;
  }

  const signer = new SignatureV4({
    service: "execute-api",
    region: config.region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method,
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: `${endpoint.pathname}${endpoint.search}`,
    headers: {
      host: endpoint.hostname,
      "content-type": "application/json",
      ...(body ? { "x-amz-content-sha256": sha256(body) } : {}),
    },
    body,
  });

  const signed = await signer.sign(request);
  const response = await fetch(endpoint, {
    method,
    headers: signed.headers as Record<string, string>,
    body,
  });

  const text = await response.text();
  let parsed: unknown = text;

  try {
    parsed = JSON.parse(text);
  } catch {}

  printJson(parsed);

  if (!response.ok) {
    process.exit(1);
  }
}

function readBrandingFlags(
  fallbackName: string,
  args: string[],
  partial = false,
): JsonRecord {
  const appName = readSingleFlag(args, "--app-name");
  const logoUrl = readSingleFlag(args, "--logo-url");
  const primaryColor = readSingleFlag(args, "--primary-color");
  const accentColor = readSingleFlag(args, "--accent-color");
  const preferredTheme = readSingleFlag(args, "--theme");
  const supportUrl = readSingleFlag(args, "--support-url");
  const legalText = readSingleFlag(args, "--legal-text");
  const allowedOrigins = readRepeatedFlag(args, "--origin");

  const branding: JsonRecord = {};
  if (appName) branding.appName = appName;
  if (!partial && fallbackName) branding.appName = branding.appName ?? fallbackName;
  if (logoUrl) branding.logoUrl = logoUrl;
  if (primaryColor) branding.primaryColor = primaryColor;
  if (accentColor) branding.accentColor = accentColor;
  if (preferredTheme) branding.preferredTheme = preferredTheme;
  if (supportUrl) branding.supportUrl = supportUrl;
  if (legalText) branding.legalText = legalText;
  if (allowedOrigins.length > 0) branding.allowedOrigins = allowedOrigins;
  return branding;
}

export function buildConfigContext(input: BuildConfigContextInput): ConfigContext {
  const requestedProfile = readSingleFlag(input.args, "--profile") ?? input.env.PAYWALLM_PROFILE;
  const flags = {
    apiUrl: readSingleFlag(input.args, "--api-url"),
    region: readSingleFlag(input.args, "--region"),
    awsProfile: readSingleFlag(input.args, "--aws-profile"),
  };
  const stored = resolveStoredConfig(input.storedConfig, requestedProfile);
  const profile = requestedProfile ?? stored.profile;
  const sources: ConfigContext["sources"] = {};

  const apiUrl = coalesceConfig(
    [
      [flags.apiUrl, "flag"],
      [input.env.PAYWALLM_API_URL, "env"],
      [stored.values.apiUrl, `config:${stored.source}`],
      [input.repoApiUrl, "cwd:.sst/outputs.json"],
    ],
    sources,
    "apiUrl",
  );
  const region = coalesceConfig(
    [
      [flags.region, "flag"],
      [input.env.AWS_REGION, "env"],
      [stored.values.region, `config:${stored.source}`],
    ],
    sources,
    "region",
  );
  const awsProfile = coalesceConfig(
    [
      [flags.awsProfile, "flag"],
      [input.env.AWS_PROFILE, "env"],
      [stored.values.awsProfile, `config:${stored.source}`],
    ],
    sources,
    "awsProfile",
  );

  if (profile) {
    sources.profile = stored.source;
  }

  return {
    apiUrl: normalizeOptional(apiUrl, ensureTrailingSlash),
    region: normalizeOptional(region),
    awsProfile: normalizeOptional(awsProfile),
    profile,
    configPath: input.configPath,
    sources,
  };
}

export function getDefaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "paywallm", "config.json");
}

export function resolveStoredConfig(
  raw: StoredConfig | undefined,
  requestedProfile?: string,
): {
  values: Pick<ConfigContext, "apiUrl" | "region" | "awsProfile">;
  profile?: string;
  source: string;
} {
  if (!raw) {
    return {
      values: {},
      source: "none",
    };
  }

  const topLevel = {
    apiUrl: normalizeOptional(raw.apiUrl),
    region: normalizeOptional(raw.region),
    awsProfile: normalizeOptional(raw.awsProfile),
  };
  const profiles = raw.profiles ?? {};
  const profileName = requestedProfile ?? pickDefaultProfile(raw);

  if (requestedProfile && !profiles[requestedProfile]) {
    throw new CliError("CONFIG_PROFILE_NOT_FOUND", `Config profile not found: ${requestedProfile}`, {
      profile: requestedProfile,
    });
  }

  const selected = profileName ? profiles[profileName] : undefined;

  return {
    values: {
      apiUrl: selected?.apiUrl ?? topLevel.apiUrl,
      region: selected?.region ?? topLevel.region,
      awsProfile: selected?.awsProfile ?? topLevel.awsProfile,
    },
    profile: profileName,
    source: profileName ? `profile:${profileName}` : "top-level",
  };
}

async function resolveCliConfig(args: string[]): Promise<CliConfig> {
  const context = await resolveConfigContext(args);

  if (!context.region) {
    throw new CliError(
      "MISSING_REGION",
      "Missing AWS region. Set --region, AWS_REGION, or configure it in ~/.config/paywallm/config.json.",
    );
  }

  if (!context.apiUrl) {
    throw new CliError(
      "MISSING_API_URL",
      "Missing API URL. Set --api-url, PAYWALLM_API_URL, configure it in ~/.config/paywallm/config.json, or run from a deployed repo with .sst/outputs.json.",
    );
  }

  return {
    apiUrl: context.apiUrl,
    region: context.region,
    awsProfile: context.awsProfile,
  };
}

async function resolveConfigContext(args: string[]): Promise<ConfigContext> {
  const configPath = normalizeOptional(readSingleFlag(args, "--config")) ?? process.env.PAYWALLM_CONFIG ?? getDefaultConfigPath();
  const [storedConfig, repoApiUrl] = await Promise.all([
    readStoredConfigFile(configPath),
    readRepoApiUrl(),
  ]);

  return buildConfigContext({
    args,
    env: process.env,
    configPath,
    storedConfig,
    repoApiUrl,
  });
}

async function readStoredConfigFile(path: string): Promise<StoredConfig | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CliError("INVALID_CONFIG_FILE", "config file must contain a JSON object");
    }
    return raw as StoredConfig;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new CliError("CONFIG_READ_FAILED", `Unable to read config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readRepoApiUrl(): Promise<string | undefined> {
  const path = resolve(process.cwd(), ".sst/outputs.json");

  try {
    await access(path, constants.F_OK);
  } catch {
    return undefined;
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiUrl = parsed.apiUrl;
    return typeof apiUrl === "string" && apiUrl.length > 0 ? apiUrl : undefined;
  } catch {
    return undefined;
  }
}

function pickDefaultProfile(config: StoredConfig): string | undefined {
  if (typeof config.defaultProfile === "string" && config.profiles?.[config.defaultProfile]) {
    return config.defaultProfile;
  }

  if (config.profiles?.default) {
    return "default";
  }

  const profileNames = Object.keys(config.profiles ?? {});
  return profileNames.length === 1 ? profileNames[0] : undefined;
}

function coalesceConfig(
  values: Array<[string | undefined, string]>,
  sources: ConfigContext["sources"],
  key: keyof ConfigContext["sources"],
): string | undefined {
  for (const [value, source] of values) {
    const normalized = normalizeOptional(value);
    if (normalized) {
      sources[key] = source;
      return normalized;
    }
  }
  return undefined;
}

function normalizeOptional(value: string | undefined, map?: (value: string) => string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return map ? map(trimmed) : trimmed;
}

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

function readRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_FLAG_VALUE", `Missing value after ${flag}`, { flag });
      }
      values.push(next);
      index += 1;
    }
  }
  return values;
}

function readSingleFlag(args: string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_FLAG_VALUE", `Missing value after ${flag}`, { flag });
      }
      return next;
    }
  }
  return undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadProjectDotenv(): void {
  loadDotenv({ path: resolve(process.cwd(), ".env") });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function printHelp(): void {
  console.log(`paywallm CLI

Purpose:
  Paywallm is a hosted auth + billing + LLM relay service for apps, games, and websites.
  This CLI is the admin tool for your deployed paywallm backend. It creates apps, manages
  entitlements, and queries usage over IAM-signed API requests using your AWS credentials.

How It Fits Into A Project:
  1. Deploy paywallm once to your AWS account.
  2. Create one app record per product/site/game with "paywallm add-app".
  3. Send users to the hosted paywall at GET /p/:appId, or embed it in an iframe.
  4. Your app then calls the public auth, billing, and /v1/apps/:appId/llm endpoints.

Who Should Run This:
  The operator of the paywallm deployment, not end users. This is for setup, support,
  automation, and admin workflows in your own infra.

Usage:
  paywallm <command> [command flags] [global flags]

Core Commands:
  paywallm config show
  paywallm whoami
  paywallm list-apps
  paywallm usage game-a --limit 25
  paywallm add-app game-a "Game A" --prices-file ./prices.json --logo-url https://example.com/logo.png --origin https://app.example.com
  paywallm add-app game-a "Game A" --price byok:subscription:month:500 --price managed:subscription:month:1500
  paywallm update-app game-a --name "Game A Deluxe" --primary-color #145af2 --accent-color #0f172a --origin https://app.example.com
  paywallm grant game-a user@example.com --mode managed --billing subscription --scheme metered
  paywallm revoke game-a user@example.com

Common Workflows:
  Create an app:
    paywallm add-app my-app "My App" --price managed:subscription:month:1500
  Grant access manually:
    paywallm grant my-app user@example.com --mode managed --billing subscription
  Inspect metered usage:
    paywallm usage my-app --limit 50

Global Flags:
  --api-url https://...
  --region us-east-1
  --aws-profile my-profile
  --profile prod
  --config ~/.config/paywallm/config.json

Config Resolution:
  1. command flags
  2. environment variables (PAYWALLM_API_URL, AWS_REGION, AWS_PROFILE, PAYWALLM_PROFILE)
  3. user config file (~/.config/paywallm/config.json)
  4. .sst/outputs.json in the current working directory (apiUrl only)

Automation Notes:
  The CLI is non-interactive and prints JSON responses, which makes it suitable for agents
  and scripts. The most explicit form is:
    PAYWALLM_API_URL=https://your-api.example.com AWS_REGION=us-east-1 paywallm list-apps

See Also:
  paywallm config --help
`);
}

function printConfigHelp(): void {
  console.log(`paywallm config

Purpose:
  Inspect which config values the CLI will use and where they came from.

Usage:
  paywallm config show [--profile name] [--config path] [--json]

Notes:
  This command does not call AWS or your API. It only resolves local config inputs.
  It always prints JSON so scripts and agents can read it directly.

Example:
  paywallm config show
  paywallm config show --profile prod
`);
}

function printWhoAmIHelp(): void {
  console.log(`paywallm whoami

Purpose:
  Show which AWS identity the CLI will use for IAM-signed admin API requests.

Usage:
  paywallm whoami [global flags]

Why It Matters:
  Use this first to confirm the active AWS account, role, and region before creating apps
  or changing user entitlements.
`);
}

function printAddAppHelp(): void {
  console.log(`paywallm add-app

Purpose:
  Create an app in your paywallm deployment and create the matching Stripe product/prices.

Usage:
  paywallm add-app <appId> <name> [price flags] [branding flags] [global flags]

Required Arguments:
  <appId>    Stable identifier used by your app and the hosted paywall route /p/:appId
  <name>     Human-readable product name

Price Input:
  --prices-file <path>   JSON array of explicit price objects
  --price <spec>         Repeatable shorthand price definition

Price Shorthand:
  <mode>:<type>:<intervalOrDash>:<amountCents>[:<flatOrMetered>[:<includedUsageUnits>[:<premiumPercent>]]]

  mode: byok | managed
  type: subscription | one_time
  intervalOrDash: month | year | -
  amountCents: integer cents
  flatOrMetered: flat | metered (optional, defaults to flat)
  includedUsageUnits: required for metered managed subscription prices
  premiumPercent: optional managed metered markup percentage

Branding Flags:
  --app-name <text>
  --logo-url <https-url>
  --primary-color <#RRGGBB>
  --accent-color <#RRGGBB>
  --theme light|dark|system
  --support-url <https-url>
  --legal-text <text>
  --origin <https-origin>   Repeatable iframe/embed allowlist

How It Fits Into A Project:
  Run this once per product/site/game that should use your paywallm deployment.
  Your client app then uses the returned app configuration through the hosted paywall
  and public API routes.

Examples:
  paywallm add-app game-a "Game A" --price managed:subscription:month:1500
  paywallm add-app game-a "Game A" --prices-file ./prices.json --origin https://game-a.example.com
`);
}

function printUpdateAppHelp(): void {
  console.log(`paywallm update-app

Purpose:
  Update app metadata and hosted paywall branding without recreating prices.

Usage:
  paywallm update-app <appId> [update flags] [global flags]

Update Flags:
  --name <text>              Rename the app record
  --app-name <text>          Override paywall display name
  --logo-url <https-url>
  --primary-color <#RRGGBB>
  --accent-color <#RRGGBB>
  --theme light|dark|system
  --support-url <https-url>
  --legal-text <text>
  --origin <https-origin>    Repeatable iframe/embed allowlist

When To Use:
  Use this when integrating paywallm into an existing app and you need to change the
  hosted paywall appearance or embedding origins without touching billing plans.

Example:
  paywallm update-app game-a --name "Game A Deluxe" --origin https://game-a.example.com
`);
}

function printUsageHelp(): void {
  console.log(`paywallm usage

Purpose:
  List recent metered usage rows for an app. This is mainly for managed metered plans.

Usage:
  paywallm usage <appId> [--email user@example.com] [--limit 50] [global flags]

Flags:
  --email <email>   Filter usage to a single user
  --limit <count>   Limit result count

What You Get:
  Recent usage ledger entries including token counts, billable units, rates, and Stripe
  reporting status.

Example:
  paywallm usage my-app --limit 25
  paywallm usage my-app --email user@example.com --limit 100
`);
}

function printGrantHelp(paid: boolean): void {
  const command = paid ? "grant" : "revoke";
  const verb = paid ? "Grant" : "Remove";
  const example = paid
    ? "paywallm grant my-app user@example.com --mode managed --billing subscription"
    : "paywallm revoke my-app user@example.com";

  console.log(`paywallm ${command}

Purpose:
  ${verb} a user's paid entitlement for a specific app.

Usage:
  paywallm ${command} <appId> <email> [--mode managed|byok] [--billing subscription|one_time] [--scheme flat|metered] [global flags]

Flags:
  --mode managed|byok            Default: managed
  --billing subscription|one_time Default: one_time
  --scheme flat|metered          Default: flat

When To Use:
  Support actions, testing, comps, migrations, or manual correction of entitlements.

Example:
  ${example}
`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function shouldUseJsonErrors(argv: string[]): boolean {
  return wantsJson(argv);
}

function formatCliError(error: unknown): { code: string; message: string; details?: JsonRecord } {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

if (isDirectRun()) {
  main().catch((error) => {
    if (shouldUseJsonErrors(process.argv.slice(2))) {
      console.error(JSON.stringify({ error: formatCliError(error) }, null, 2));
    } else {
      const formatted = formatCliError(error);
      console.error(`${formatted.code}: ${formatted.message}`);
    }
    process.exit(1);
  });
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}
