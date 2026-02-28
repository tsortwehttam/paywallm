import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderPayload, normalizeProviderResponse } from "../src/llm.js";

test("buildProviderPayload maps OpenAI messages to Responses API input", () => {
  assert.deepEqual(
    buildProviderPayload({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.4,
      maxOutputTokens: 300,
    }),
    {
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "Be concise." }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      temperature: 0.4,
      max_output_tokens: 300,
    },
  );
});

test("buildProviderPayload preserves OpenRouter chat payload shape", () => {
  assert.deepEqual(
    buildProviderPayload({
      provider: "openrouter",
      model: "openrouter/auto",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.1,
      maxOutputTokens: 150,
    }),
    {
      model: "openrouter/auto",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.1,
      max_tokens: 150,
    },
  );
});

test("normalizeProviderResponse extracts OpenAI response text and usage", () => {
  assert.deepEqual(
    normalizeProviderResponse("openai", {
      status: "completed",
      output: [
        {
          content: [
            { type: "output_text", text: "Hello " },
            { type: "output_text", output_text: "world" },
          ],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
      },
    }),
    {
      outputText: "Hello world",
      finishReason: "completed",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    },
  );
});

test("normalizeProviderResponse extracts Anthropic response text and usage", () => {
  assert.deepEqual(
    normalizeProviderResponse("anthropic", {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Claude says hi." }],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
      },
    }),
    {
      outputText: "Claude says hi.",
      finishReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    },
  );
});

test("normalizeProviderResponse extracts OpenRouter response text and usage", () => {
  assert.deepEqual(
    normalizeProviderResponse("openrouter", {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "Routed response",
          },
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 7,
        total_tokens: 27,
      },
    }),
    {
      outputText: "Routed response",
      finishReason: "stop",
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 27,
      },
    },
  );
});

test("buildProviderPayload folds Anthropic system messages correctly", () => {
  assert.deepEqual(
    buildProviderPayload({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
      temperature: 0.3,
      maxOutputTokens: 200,
    }),
    {
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
      system: "Be concise.",
      temperature: 0.3,
    },
  );
});
