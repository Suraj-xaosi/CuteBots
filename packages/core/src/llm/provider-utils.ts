import { getEncoding } from "js-tiktoken";
import { ErrorCode, type LLMMessage, type Result } from "@workspace/types";

const tokenizer = getEncoding("cl100k_base");

export function countMessageTokens(messages: LLMMessage[]): number {
  const text = messages.map((message) => {
    if (message.role === "assistant") {
      return `${message.content}\n${JSON.stringify(message.tool_calls ?? [])}`;
    }
    if (message.role === "tool") {
      return `${message.tool_call_id}\n${message.content}`;
    }
    return message.content;
  }).join("\n");
  return tokenizer.encode(text).length;
}

export function mapProviderError(error: unknown, apiKey?: string): Result<never> {
  const status = readStatus(error);
  const rawMessage = error instanceof Error ? error.message : "LLM provider request failed";
  const message = apiKey ? rawMessage.split(apiKey).join("***") : rawMessage;

  let code = ErrorCode.LLM_API_ERROR;
  if (status === 429) {
    code = ErrorCode.LLM_RATE_LIMIT;
  } else if (status === 401) {
    code = ErrorCode.INVALID_API_KEY;
  } else if (/context.{0,30}(length|window|limit)|too many tokens|maximum context/i.test(message)) {
    code = ErrorCode.LLM_CONTEXT_OVERFLOW;
  } else if (status !== undefined && status >= 400 && status < 500 && ![408, 409, 425].includes(status)) {
    code = ErrorCode.LLM_REQUEST_ERROR;
  }

  const retryAfterMs = readRetryAfterMs(error) ?? readRetryDelayFromMessage(rawMessage);
  return {
    ok: false,
    error: message || "LLM provider request failed",
    code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function readStatus(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function readRetryAfterMs(error: unknown) {
  if (typeof error !== "object" || error === null || !("headers" in error)) return undefined;
  const headers = error.headers;
  let value: string | null | undefined;
  if (headers instanceof Headers) {
    value = headers.get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    const header = record["retry-after"] ?? record["Retry-After"];
    if (typeof header === "string" || typeof header === "number") value = String(header);
  }
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function readRetryDelayFromMessage(message: string) {
  const match = message.match(/(?:try again|retry) in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)/i);
  if (!match?.[1] || !match[2]) return undefined;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("ms") ? 1 : unit.startsWith("s") ? 1_000 : 60_000;
  return Math.ceil(value * multiplier);
}
