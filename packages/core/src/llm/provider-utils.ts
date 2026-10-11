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

export function parseToolArguments(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM returned tool arguments that were not a JSON object");
  }
  return parsed as Record<string, unknown>;
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

  const retryAfterMs = readRetryAfterMs(error);
  return {
    ok: false,
    error: message || "LLM provider request failed",
    code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
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

export function mapOpenAIFinishReason(reason: string | null): "stop" | "tool_use" | "length" | "error" {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  return "error";
}

export function mapAnthropicStopReason(reason: string | null): "stop" | "tool_use" | "length" | "error" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return "error";
}
