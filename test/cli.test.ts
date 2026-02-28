import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigContext, resolveStoredConfig } from "../src/cli.js";

test("resolveStoredConfig merges selected profile over top-level defaults", () => {
  const resolved = resolveStoredConfig(
    {
      apiUrl: "https://base.example.com",
      region: "us-west-2",
      profiles: {
        prod: {
          apiUrl: "https://prod.example.com",
          awsProfile: "paywallm-prod",
        },
      },
    },
    "prod",
  );

  assert.deepEqual(resolved, {
    values: {
      apiUrl: "https://prod.example.com",
      region: "us-west-2",
      awsProfile: "paywallm-prod",
    },
    profile: "prod",
    source: "profile:prod",
  });
});

test("buildConfigContext uses flags first, then env, then config, then repo fallback", () => {
  const context = buildConfigContext({
    args: ["--api-url", "https://flag.example.com", "--region", "us-east-1", "--aws-profile", "cli"],
    env: {
      PAYWALLM_API_URL: "https://env.example.com",
      AWS_REGION: "us-west-2",
      AWS_PROFILE: "env",
    },
    configPath: "/tmp/paywallm.json",
    storedConfig: {
      apiUrl: "https://config.example.com",
      region: "eu-west-1",
      awsProfile: "config",
    },
    repoApiUrl: "https://repo.example.com",
  });

  assert.deepEqual(context, {
    apiUrl: "https://flag.example.com/",
    region: "us-east-1",
    awsProfile: "cli",
    profile: undefined,
    configPath: "/tmp/paywallm.json",
    sources: {
      apiUrl: "flag",
      region: "flag",
      awsProfile: "flag",
    },
  });
});

test("buildConfigContext falls back to config and repo values when env is absent", () => {
  const context = buildConfigContext({
    args: ["--profile", "default"],
    env: {},
    configPath: "/tmp/paywallm.json",
    storedConfig: {
      profiles: {
        default: {
          region: "us-east-2",
          awsProfile: "paywallm",
        },
      },
    },
    repoApiUrl: "https://repo.example.com",
  });

  assert.deepEqual(context, {
    apiUrl: "https://repo.example.com/",
    region: "us-east-2",
    awsProfile: "paywallm",
    profile: "default",
    configPath: "/tmp/paywallm.json",
    sources: {
      apiUrl: "cwd:.sst/outputs.json",
      region: "config:profile:default",
      awsProfile: "config:profile:default",
      profile: "profile:default",
    },
  });
});

test("resolveStoredConfig rejects unknown explicit profiles", () => {
  assert.throws(
    () =>
      resolveStoredConfig(
        {
          profiles: {
            default: {
              region: "us-east-1",
            },
          },
        },
        "prod",
      ),
    /Config profile not found: prod/,
  );
});
