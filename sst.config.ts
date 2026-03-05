declare const $config: (config: {
  app: (input?: { stage?: string }) => Record<string, unknown>;
  run: () => Promise<Record<string, unknown>>;
}) => unknown;
declare const sst: any;

export default $config({
  app(input?: { stage?: string }) {
    return {
      name: "paywallm",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    await import("dotenv/config");
    const required = [
      "AWS_REGION",
      "AWS_ACCOUNT_ID",
      "AWS_KMS_KEY_ID",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_SUCCESS_URL",
      "STRIPE_CANCEL_URL",
      "SES_FROM_EMAIL",
    ] as const;

    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required env var in .env: ${key}`);
      }
    }

    const table = new sst.aws.Dynamo("PaywallTable", {
      fields: {
        pk: "string",
        sk: "string",
        gsi1pk: "string",
        gsi1sk: "string",
      },
      primaryIndex: {
        hashKey: "pk",
        rangeKey: "sk",
      },
      globalIndexes: {
        Gsi1: {
          hashKey: "gsi1pk",
          rangeKey: "gsi1sk",
        },
      },
      ttl: "ttl",
    });

    const sharedHandler = {
      handler: "src/server.handler",
      runtime: "nodejs20.x",
      timeout: "30 seconds",
      memory: "1024 MB",
      link: [table],
      permissions: [
        {
          actions: [
            "kms:Encrypt",
            "kms:Decrypt",
            "kms:GenerateDataKey",
            "ses:SendEmail",
            "ses:SendRawEmail",
          ],
          resources: ["*"],
        },
      ],
      environment: {
        TABLE_NAME: table.name,
        AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID!,
        AWS_KMS_KEY_ID: process.env.AWS_KMS_KEY_ID!,
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
        STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
        STRIPE_SUCCESS_URL: process.env.STRIPE_SUCCESS_URL!,
        STRIPE_CANCEL_URL: process.env.STRIPE_CANCEL_URL!,
        SES_FROM_EMAIL: process.env.SES_FROM_EMAIL!,
        DEV_ECHO_LOGIN_CODE: process.env.DEV_ECHO_LOGIN_CODE ?? "0",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
      },
    } as const;

    const api = new sst.aws.ApiGatewayV2("Api");

    const publicRoutes = [
      "OPTIONS /{proxy+}",
      "GET /preview",
      "GET /preview/paywall",
      "GET /p/{appId}",
      "POST /auth/start",
      "POST /auth/verify",
      "POST /auth/logout",
      "GET /me",
      "POST /billing/checkout",
      "POST /billing/portal",
      "POST /stripe/webhook",
      "POST /v1/apps/{appId}/llm",
      "POST /v1/apps/{appId}/keys",
    ];

    for (const route of publicRoutes) {
      api.route(route, sharedHandler);
    }

    const adminRoutes = [
      "POST /admin/apps",
      "GET /admin/apps",
      "PATCH /admin/apps/{appId}",
      "GET /admin/apps/{appId}/usage",
      "POST /admin/apps/{appId}/prices",
      "POST /admin/users/{appId}/{email}/grant",
      "POST /admin/users/{appId}/{email}/revoke",
    ];

    for (const route of adminRoutes) {
      api.route(route, sharedHandler, {
        auth: {
          iam: true,
        },
      });
    }

    return {
      apiUrl: api.url,
      tableName: table.name,
    };
  },
});
