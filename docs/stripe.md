# Billing for LLM tokens integration guide

Charge your customers for LLM token costs.

Billing for LLM tokens allows you to set up usage-based billing for products that use LLMs (for example, vibe coding apps, AI application builders, and GPT wrappers).

It’s for developers who want to directly pass along the cost of their LLM tokens plus their desired markup to the end customer.

Billing for LLM tokens is currently in private preview. The goal of the private preview is to validate whether the core end-to-end flow can serve your highest priority needs, and what areas we need to continue to prioritize as we develop this feature.

### Key features of Billing for LLM tokens

Billing for LLM tokens:

- Automatically sets up Stripe rate card and rate card rates for input and output tokens of select LLMs, and the meter to track usage per customer
- Adds a configurable percentage markup to token costs
- Keeps LLM token costs up to date over time, and optionally have your customers always billed at the latest token costs
- Automatically tracks LLM usage per customer, broken down by model and token type when the request is routed through the Stripe AI Gateway
- Charges customers for their usage (token costs plus markup) at the end of the billing cycle

### Billing for LLM tokens versus Stripe Usage-Based Billing

We built billing for LLM tokens on top of Usage-Based Billing, with the addition of LLM token price management. You can perform similar actions with Stripe Usage Based Billing alone but billing for LLM tokens helps the setup further when you bill usage based on LLM tokens.

Use Billing for LLM tokens if:

- You plan to charge users based on their usage of LLMs
- You don’t want to keep track of underlying LLM token price changes
- You plan to set up LLM usage meters but don’t want to manage the underlying Stripe objects individually

Don’t use Billing for LLM tokens and just use Usage-Based Billing if:

- You don’t plan on charging users for their LLM usage
- You plan to charge users per “request” or per “action” as opposed to per token
- You plan to abstract away all concept of tokens into “credits” and charge for credits instead of tokens

## How to integrate

If you’re interested in billing for LLM tokens, share your Stripe account ID and sandbox ID with us and we can give you access to the preview. (You only need to share the sandbox ID if you’re starting your integration in a test sandbox).

1. Set up your pricing model

Go to the [billing for LLM tokens Dashboard](https://dashboard.stripe.com/token-billing) to set up your desired pricing model and markup percentage on top of LLM token costs.

You must use the Dashboard flow to create billing for LLM tokens pricing plans. You can’t create billing for LLM tokens pricing plans through the API.

After you set up your pricing model, you’ll have a pricing plan ready for your customers.

1. Subscribe a customer to your pricing plan

Subscribe your customer to the pricing plan you created in step 1. You can do this through the Dashboard or API. See the [subscription documentation](https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans.md?payment-ui=direct-api#subscribe) for more details.

1. Integrate usage tracking

Choose one of the following integration options to start tracking your customers’ LLM usage.

#### Option A: Use the Stripe AI Gateway

Route your LLM requests through **https://llm.stripe.com** to automatically track usage. We recommend this option, and it supports multiple model providers.

The AI Gateway acts as a unified endpoint for all supported model providers. You send requests to the Stripe endpoint, and we route them to the appropriate provider, return the response, and automatically record token usage for billing.

### Getting started

To make an API call, you need:

- **Customer ID**: The customer ID of the user you’ll charge for LLM usage, with the `cus_` prefix.
- **API Key**: Your Stripe API key.

You can use the same format you use for calling a model provider’s endpoint directly, with these changes:

- Use the Stripe AI Gateway endpoint: **https://llm.stripe.com/{endpoint}**
- Add your Stripe API key as your authorization token in bearer format
- Include the `X-Stripe-Customer-ID` header with the customer you want to charge

Example using cURL:

```bash
curl -X POST "https://llm.stripe.com/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
    "model": "openai/gpt-4.1",
    "messages": [
      {
        "role": "user",
        "content": "How tall is the average llama?"
      }
    ]
  }'
```

For a full list of currently supported models, see [Supported models](https://docs.stripe.com/billing/token-billing/integration-guide.md#supported-models) below.

### Integration Examples

This section shows how to use the Stripe AI Gateway with different model providers.

#### OpenAI

cURL example:

```bash
curl https://llm.stripe.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
    "model": "openai/gpt-5",
    "messages": [
      {
        "role": "user",
        "content": "How tall is the average llama?"
      }
    ]
  }'
```

Using the OpenAI SDK:

```js
const OpenAI = require('openai');
client = new OpenAI({
  apiKey: <<YOUR_SECRET_KEY>>,
  baseURL: 'https://llm.stripe.com',
  defaultHeaders: {
    'X-Stripe-Customer-Id': STRIPE_CUSTOMER_ID
  }
});

const completion = await client.chat.completions.create({
  model: 'openai/gpt-5',
  messages: [
    {
      role: 'user',
      content: "How tall is the average llama?"
    }
  ],
});

console.log(completion.choices[0].message.content);
```

#### Google Gemini

Using Google’s native format (cURL example):

```bash
curl -X POST "https://llm.stripe.com/publishers/google/models/gemini-2.5-pro:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
  "contents": {
    "role": "user",
    "parts": {
      "text": "How tall is the average llama?"
    }
  }
}'
```

Using the OpenAI compatible format:

```bash
curl -X POST "https://llm.stripe.com/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
    "model": "google/gemini-2.5-pro",
    "messages": [
      {
        "role": "user",
        "content": "How tall is the average llama?"
      }
    ]
  }'
```

#### Anthropic

Using cURL:

```bash
curl -X POST "https://llm.stripe.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "How tall is the average llama?"
      }
    ]
  }'
```

Using Anthropic’s SDK:

```js
const Anthropic = require('@anthropic-ai/sdk');
const anthropicClient = new Anthropic({
  apiKey: "fake", // no op - you can put any string in here, it will be ignored
  baseURL: 'https://llm.stripe.com',
  defaultHeaders: {
    'X-Stripe-Customer-Id': "{{CUSTOMER_ID}}",
    'Authorization': `Bearer <<YOUR_SECRET_KEY>>`
  }
});

const response = await anthropicClient.messages.create({
  model: "anthropic/claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: "How tall is the average llama?"
    }
  ]
});
```

Using the OpenAI compatible format:

```js
const OpenAI = require('openai');
const openAIClient = new OpenAI({
  apiKey: <<YOUR_SECRET_KEY>>,
  baseURL: 'https://llm.stripe.com',
  defaultHeaders: {
    'X-Stripe-Customer-Id': STRIPE_CUSTOMER_ID
  }
});

const completion = await openAIClient.chat.completions.create({
  model: 'anthropic/claude-sonnet-4',
  messages: [
    {
      role: 'user',
      content: "How tall is the average llama?"
    }
  ],
});

console.log(completion.choices[0].message.content);
```

### Use the Vercel AI SDK with the Stripe AI Gateway

We created an AI SDK provider so that you can use our Stripe AI Gateway directly through the AI SDK.

```js
import { createStripe } from '@stripe/ai-sdk/provider';
import { generateText } from 'ai';

const stripeLLM = createStripe({
  apiKey: <<YOUR_SECRET_KEY>>,
  customerId: {{CUSTOMER_ID}},
});

const { text } = await generateText({
  model: stripe('openai/gpt-5'),
  prompt: 'How tall is the average llama?',
});
```

See the [full documentation](https://www.npmjs.com/package/@stripe/ai-sdk) for more details.

### Streaming

The Stripe AI Gateway supports streaming responses. To enable streaming, pass in `stream: true` and the `stream_options[include_usage]` parameter:

```bash
curl https://llm.stripe.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "X-Stripe-Customer-ID: {{CUSTOMER_ID}}" \
  -d '{
    "model": "openai/gpt-5",
    "messages": [
      {
        "role": "user",
        "content": "How tall is the average llama?"
      }
    ],
    "stream": true,
    "stream_options": {
        "include_usage": true
    }
  }'
```

#### Option B: Use an integration partner

We have partnerships with several AI gateway providers for usage tracking. If you’re already using an AI gateway provider and prefer to continue using them, we can help you set up billing for LLM tokens with them.

### Supported integration partners

#### OpenRouter

The [OpenRouter](https://openrouter.ai/) integration captures token usage and reports it to Stripe in real time. If you’re already using OpenRouter to access multiple model providers, this integration adds Stripe billing by changing one line of code.

#### Vercel AI SDK

The [Vercel AI SDK](https://sdk.vercel.ai/) integration automatically captures and reports token usage to Stripe as requests flow through Vercel’s infrastructure, eliminating the need for manual tracking. If you’re already using Vercel’s AI Gateway, this is the fastest way to get started with billing for LLM tokens.

#### Cloudflare AI Gateway

[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) integration captures and reports usage automatically. When you route your LLM requests through Cloudflare’s AI Gateway, usage data flows directly to Stripe for accurate billing.

### Getting started with a partner integration

Contact us at [token-billing-team@stripe.com](mailto:token-billing-team@stripe.com) to set up a shared channel with you, Stripe, and your partner of choice. We’ll help configure the integration and ensure usage data flows correctly to Stripe for billing.

#### Option C: Self-report Usage

If you prefer to manage your own LLM provider connections, you can report usage to Stripe directly. You have three options for doing so:

### Use the token meter SDK with direct SDKs

The [token meter SDK](https://www.npmjs.com/package/@stripe/token-meter) integrates with provider SDKs (OpenAI, Anthropic, and so on) to automatically report usage to Stripe.

See the Token Meter [installation instructions and usage examples](https://www.npmjs.com/package/@stripe/token-meter).

### Using HTTP requests

You can send POST requests to `/v2/billing/meter_events` ([documentation](https://docs.stripe.com/api/billing/meter-event/create.md)) with the number and type of tokens used. Set the event name to `token-billing-tokens`, and make sure the model field matches the model value in the rate card you created so we can correctly track the token usage.

Here’s an example using curl:

```bash
curl -X POST https://api.stripe.com/v2/billing/meter_events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <<YOUR_SECRET_KEY>>" \
  -H "Stripe-Version: 2025-09-30.preview" \
  -d '{
    "event_name": "token-billing-tokens",
    "payload": {
      "stripe_customer_id": "{{CUSTOMER_ID}}",
      "value": "1000",
      "model": "openai/gpt-5.2",
      "token_type": "input"
    }
  }'
```

Here’s an example of how you can do this with OpenAI’s usage in TypeScript:

```js
const OpenAI = require('openai');
client = new OpenAI({
  apiKey: openAiApiKey
});

const embedding = await openai.embeddings.create({
  model: "text-embedding-ada-002",
  input: "The quick brown fox jumped over the lazy dog",
  encoding_format: "float",
});

const usage = embedding.usage || {};
const promptTokens = usage.prompt_tokens || 0;

await fetch('https://api.stripe.com/v2/billing/meter_events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer <<YOUR_SECRET_KEY>>`,
    'Stripe-Version': '2025-09-30.preview'
  },
  body: JSON.stringify({
    event_name: 'token-billing-tokens',
    payload: {
      stripe_customer_id: stripeCustomerId,
      value: promptTokens.toString(),
      model: 'openai/text-embedding-ada-002',
      token_type: 'input'
    }
  })
});

console.log(embedding);
```

### Supported token types

When reporting usage, you can specify the following token types in the `token_type` field:

- `input`
- `output`
- `cached_input`
- `cache_read` (only supported for Anthropic models)
- `cache_write` (only supported for Anthropic models)

### Self-reporting usage with a Vercel AI SDK provider

If you want to use your own provider and not our AI Gateway (but still want to use billing for LLM tokens for tracking and charging customers), you can use the `meteredModel` function to track usage for any AI SDK model:

```js
import { meteredModel } from '@stripe/ai-sdk/meter';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = meteredModel(
  openai('gpt-4o-mini'),
  <<YOUR_SECRET_KEY>>,{{CUSTOMER_ID}}
);

const { text } = await generateText({
  model,
  prompt: 'How tall is the average llama?',
});
```

[See the AI SDK documentation](https://www.npmjs.com/package/@stripe/ai-sdk) for more details.

1. View usage metrics

After sending requests through any of the integration options above, you can view usage accrued by a customer directly in the Stripe Dashboard.

To view metered usage, go to **Usage-based billing** in the Dashboard, click the **Meters** tab, and select your billing for LLM tokens meter. You’ll see the latest events reflected in the meter details page.

You can also view a customer’s accrued usage on their subscription page by checking the *preview invoice*. The preview invoice shows token usage by model, current billing period usage, and a breakdown by token type. Use the preview invoice to verify that usage is being tracked correctly and to see what your customer will be billed at the end of the billing cycle.

## Support for non-text based responses

The Stripe AI Gateway supports image understanding and generation in a limited capacity, but doesn’t currently support other types. If multi-modal functionality is a core part of your product, send us a request to see if we can integrate it.

## Token price updates

When model providers update their pricing or release new models, we notify you of the changes. You can also choose from two additional levels of automatic action that you can configure per rate card:

1. **Apply to new customers**: Automatically use updated prices for new customers by default.
1. **Apply to all customers**: Automatically use updated prices for new customers, and also apply the new prices to existing customers.

## Overage charges

If you’re pricing model includes an overage portion, we bill your customers at the end of their subscription cycle.

## LLM token costs for the Stripe AI Gateway

We won’t charge you for LLM token usage during the preview, we’ll limit your usage instead. We’ll notify you when this changes. When it changes, we’ll likely bill you at the end of the month for token costs incurred by your customers.

## Supported models

Currently, the Stripe AI Gateway supports text-based LLMs. We’ll consider adding models to this list prioritized by your requests. If there’s a model you want us to support, contact us at [token-billing-team@stripe.com](mailto:token-billing-team@stripe.com).

> Anthropic and Gemini models are served through Google Vertex AI. OpenAI models are served directly through OpenAI.

### OpenAI Models

- openai/gpt-5.3-codex
- openai/gpt-5.2
- openai/gpt-5.2-pro
- openai/gpt-5.2-chat-latest
- openai/gpt-5.1
- openai/gpt-5.1-chat-latest
- openai/gpt-5.1-codex
- openai/gpt-5.1-codex-max
- openai/gpt-5
- openai/gpt-5-mini
- openai/gpt-5-nano
- openai/gpt-5-chat-latest
- openai/gpt-4.1
- openai/gpt-4.1-mini
- openai/gpt-4.1-nano
- openai/gpt-4o
- openai/gpt-4o-mini
- openai/o4-mini
- openai/o3
- openai/o3-mini
- openai/o3-pro
- openai/o1
- openai/o1-mini
- openai/o1-pro

### Gemini Models

- google/gemini-3.1-pro-preview
- google/gemini-3.1-flash-preview
- google/gemini-3-flash
- google/gemini-3-pro-preview
- google/gemini-2.5-pro
- google/gemini-2.5-flash
- google/gemini-2.5-flash-image
- google/gemini-2.5-flash-lite
- google/gemini-2.0-flash
- google/gemini-2.0-flash-lite

### Anthropic Models

- anthropic/claude-opus-4.6
- anthropic/claude-opus-4.5
- anthropic/claude-opus-4.1
- anthropic/claude-opus-4
- anthropic/claude-sonnet-4.6
- anthropic/claude-sonnet-4.5
- anthropic/claude-sonnet-4
- anthropic/claude-3.7-sonnet
- anthropic/claude-3.7-sonnet-latest
- anthropic/claude-haiku-4.5
- anthropic/claude-3.5-haiku
- anthropic/claude-3.5-haiku-latest
- anthropic/claude-3-haiku

### Supported endpoints

#### OpenAI endpoints

OpenAI format:

- `/chat/completions`
- `/responses`

#### Google endpoints

OpenAI format:

- `/chat/completions`

Vertex format:

- `generateContent`

#### Anthropic endpoints

OpenAI format:

- `/chat/completions`

Anthropic format:

- `/v1/messages`

### Image and vision

#### Image understanding

In supported endpoints that have image understanding capabilities, we support image inputs in public URL or base64 encoded format.

#### Image generation

In supported endpoints that have image generation capabilities, image output is in base64 encoded format.

### Limitations

We currently have a request size limit of 4MB. If you need a higher limit, you can contact us at [token-billing-team@stripe.com](mailto:token-billing-team@stripe.com) to request one.

## Feedback and feature requests

Contact the billing for LLM tokens team directly with any feedback, questions, or issues that you encounter at [token-billing-team@stripe.com](mailto:token-billing-team@stripe.com).

## Data consent

You’re responsible for obtaining all necessary rights and consents from your customers to allow Stripe to process their data.