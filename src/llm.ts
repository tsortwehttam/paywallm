import type { Provider, RelayMessage } from "./shared.js";

export type NormalizedLlmResponse = {
  outputText: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export function buildProviderPayload(input: {
  provider: Provider;
  model: string;
  messages: RelayMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  if (input.provider === "openai") {
    return {
      model: input.model,
      input: input.messages.map((message) => ({
        role: message.role,
        content: [{ type: "input_text", text: message.content }],
      })),
      temperature: input.temperature,
      max_output_tokens: input.maxOutputTokens,
    };
  }

  if (input.provider === "anthropic") {
    return {
      model: input.model,
      max_tokens: input.maxOutputTokens ?? 1024,
      messages: input.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
        })),
      system:
        input.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n\n") || undefined,
      temperature: input.temperature,
    };
  }

  return {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxOutputTokens,
  };
}

export function normalizeProviderResponse(
  provider: Provider,
  upstream: unknown,
): NormalizedLlmResponse {
  const record = asObject(upstream);

  if (provider === "openai") {
    const outputText = readOpenAiOutputText(record);
    const finishReason = readOptionalString(record.status);
    const usage = asObjectOrUndefined(record.usage);
    const inputTokens = readOptionalNumber(usage?.input_tokens);
    const outputTokens = readOptionalNumber(usage?.output_tokens);
    const totalTokens = readOptionalNumber(usage?.total_tokens);
    return {
      outputText,
      finishReason,
      usage: anyDefined(inputTokens, outputTokens, totalTokens)
        ? { inputTokens, outputTokens, totalTokens }
        : undefined,
    };
  }

  if (provider === "anthropic") {
    const content = Array.isArray(record.content) ? record.content : [];
    const outputText = content
      .map((entry) => {
        const part = asObject(entry);
        return readOptionalString(part.text) ?? "";
      })
      .join("");
    const finishReason = readOptionalString(record.stop_reason);
    const usage = asObjectOrUndefined(record.usage);
    const inputTokens = readOptionalNumber(usage?.input_tokens);
    const outputTokens = readOptionalNumber(usage?.output_tokens);
    const totalTokens =
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    return {
      outputText,
      finishReason,
      usage: anyDefined(inputTokens, outputTokens, totalTokens)
        ? { inputTokens, outputTokens, totalTokens }
        : undefined,
    };
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices.length > 0 ? asObject(choices[0]) : undefined;
  const message = asObjectOrUndefined(firstChoice?.message);
  const outputText = readOptionalString(message?.content) ?? "";
  const finishReason = readOptionalString(firstChoice?.finish_reason);
  const usage = asObjectOrUndefined(record.usage);
  const inputTokens = readOptionalNumber(usage?.prompt_tokens);
  const outputTokens = readOptionalNumber(usage?.completion_tokens);
  const totalTokens = readOptionalNumber(usage?.total_tokens);
  return {
    outputText,
    finishReason,
    usage: anyDefined(inputTokens, outputTokens, totalTokens)
      ? { inputTokens, outputTokens, totalTokens }
      : undefined,
  };
}

function readOpenAiOutputText(record: Record<string, unknown>): string {
  const output = Array.isArray(record.output) ? record.output : [];
  return output
    .flatMap((item) => {
      const content = asObject(item).content;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => {
      const part = asObject(item);
      return readOptionalString(part.text) ?? readOptionalString(part.output_text) ?? "";
    })
    .join("");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const record = asObject(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function anyDefined(...values: Array<unknown>): boolean {
  return values.some((value) => value !== undefined);
}
