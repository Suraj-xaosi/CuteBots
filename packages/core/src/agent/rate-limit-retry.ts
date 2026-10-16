import { ErrorCode, type LLMMessage, type LLMProvider, type LLMResponse, type Result, type ToolDefinition } from "@workspace/types";

const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export async function chatWithRateLimitRetry(
  provider: LLMProvider,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  systemPrompt: string,
  signal: AbortSignal | undefined,
  onRetry: (message: string) => Promise<void>,
): Promise<Result<LLMResponse>> {
  for (let retry = 0; ; retry += 1) {
    const response = await provider.chat(messages, tools, systemPrompt, signal);
    if (response.ok || response.code !== ErrorCode.LLM_RATE_LIMIT || retry >= MAX_RATE_LIMIT_RETRIES) {
      return response;
    }

    const waitMs = response.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
    await onRetry(
      `Provider rate limit reached. Retrying in ${formatWait(waitMs)} (${retry + 1}/${MAX_RATE_LIMIT_RETRIES}).`,
    );
    await waitForRetry(waitMs, signal);
  }
}

function formatWait(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  return seconds >= 60
    ? `${Math.ceil(seconds / 60)} minute${seconds >= 120 ? "s" : ""}`
    : `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Task cancelled"));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Task cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
