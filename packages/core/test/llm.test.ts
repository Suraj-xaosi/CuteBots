import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, type LLMMessage, type LLMProvider } from "@workspace/types";
import { AnthropicProvider } from "../src/llm/anthropic-provider.js";
import { LLMClient } from "../src/llm/llm-client.js";
import { GroqProvider, OpenAIProvider } from "../src/llm/openai-providers.js";

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const conversation: LLMMessage[] = [
  { role: "user", content: "Check the workspace" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", name: "run_command", arguments: { command: "pwd" } }],
  },
  { role: "tool", tool_call_id: "call-1", content: "/workspace" },
];

async function assertProviderRequestAborts(
  createProvider: (fetcher: typeof fetch) => LLMProvider,
): Promise<void> {
  let requestStartedResolve: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
  let requestSignal: AbortSignal | undefined;
  const provider = createProvider(mockFetch((request) => {
    requestSignal = request.signal;
    requestStartedResolve?.();
    return new Promise<Response>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Provider request was not aborted")), 5_000);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new DOMException("Provider request aborted", "AbortError"));
      }, { once: true });
    });
  }));
  const controller = new AbortController();
  const pending = provider.chat([], [], "system", controller.signal);

  await requestStarted;
  controller.abort();
  const result = await pending;

  assert.equal(requestSignal?.aborted, true);
  assert.equal(result.ok, false);
}

test("OpenAI normalizes tool calls and replays assistant/tool history", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAIProvider({
    provider: "openai",
    apiKey: "test-openai-key",
    fetcher: mockFetch(async (request) => {
      requestBody = await request.json() as Record<string, unknown>;
      return jsonResponse({
        id: "completion-1",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-2",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"package.json"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
    }),
  });

  const result = await provider.chat(conversation, [{
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }], "You are a coding agent");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.finish_reason, "tool_use");
  assert.equal(result.data.usage.input_tokens, 20);
  assert.deepEqual(result.data.tool_calls[0]?.arguments, { path: "package.json" });
  const messages = requestBody?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[2]?.tool_calls !== undefined, true);
  assert.equal(messages[3]?.role, "tool");
});

test("Anthropic coalesces tool results and normalizes text, calls, and usage", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new AnthropicProvider({
    apiKey: "test-anthropic-key",
    fetcher: mockFetch(async (request) => {
      requestBody = await request.json() as Record<string, unknown>;
      return jsonResponse({
        id: "message-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "I inspected the workspace." },
          { type: "tool_use", id: "call-2", name: "read_file", input: { path: "package.json" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 7 },
      });
    }),
  });

  const result = await provider.chat(conversation, [], "You are a coding agent");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.finish_reason, "tool_use");
  assert.equal(result.data.content, "I inspected the workspace.");
  assert.equal(result.data.usage.output_tokens, 7);
  const messages = requestBody?.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 3);
  assert.equal(messages[2]?.role, "user");
  assert.equal(Array.isArray(messages[2]?.content), true);
  assert.equal(requestBody?.system, "You are a coding agent");
});

test("OpenAI and Anthropic abort their active HTTP request when signaled", async () => {
  await assertProviderRequestAborts((fetcher) => new OpenAIProvider({
    provider: "openai",
    apiKey: "test-openai-key",
    fetcher,
  }));
  await assertProviderRequestAborts((fetcher) => new AnthropicProvider({
    apiKey: "test-anthropic-key",
    fetcher,
  }));
});

test("provider errors normalize rate limits, invalid keys, and context overflow", async () => {
  const rateLimited = new OpenAIProvider({
    provider: "openai",
    apiKey: "key",
    fetcher: mockFetch(async () => jsonResponse({ error: { message: "rate limit" } }, 429)),
  });
  const invalidKey = new OpenAIProvider({
    provider: "openai",
    apiKey: "key",
    fetcher: mockFetch(async () => jsonResponse({ error: { message: "invalid key" } }, 401)),
  });
  const contextOverflow = new OpenAIProvider({
    provider: "openai",
    apiKey: "key",
    fetcher: mockFetch(async () => jsonResponse({ error: { message: "maximum context length exceeded" } }, 400)),
  });
  const permanentRequestError = new OpenAIProvider({
    provider: "openai",
    apiKey: "key",
    fetcher: mockFetch(async () => jsonResponse({ error: { message: "invalid request" } }, 400)),
  });

  const rateResult = await rateLimited.chat([], [], "system");
  const keyResult = await invalidKey.chat([], [], "system");
  const contextResult = await contextOverflow.chat([], [], "system");
  const requestResult = await permanentRequestError.chat([], [], "system");

  assert.equal(rateResult.ok, false);
  assert.equal(keyResult.ok, false);
  assert.equal(contextResult.ok, false);
  assert.equal(requestResult.ok, false);
  if (!rateResult.ok && !keyResult.ok && !contextResult.ok && !requestResult.ok) {
    assert.equal(rateResult.code, ErrorCode.LLM_RATE_LIMIT);
    assert.equal(keyResult.code, ErrorCode.INVALID_API_KEY);
    assert.equal(contextResult.code, ErrorCode.LLM_CONTEXT_OVERFLOW);
    assert.equal(requestResult.code, ErrorCode.LLM_REQUEST_ERROR);
  }
});

test("provider maps Retry-After headers to milliseconds", async () => {
  const provider = new OpenAIProvider({
    provider: "openai",
    apiKey: "key",
    fetcher: mockFetch(async () => new Response(
      JSON.stringify({ error: { message: "rate limit" } }),
      { status: 429, headers: { "Retry-After": "2.5", "Content-Type": "application/json" } },
    )),
  });

  const result = await provider.chat([], [], "system");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ErrorCode.LLM_RATE_LIMIT);
    assert.equal(result.retryAfterMs, 2_500);
  }
});

test("Ollama needs no API key and counts tokens locally", async () => {
  const client = new LLMClient({ provider: "ollama" });

  assert.equal(client.name, "ollama");
  assert.equal(client.maxContextTokens, 32_768);
  assert.equal(await client.countTokens([{ role: "user", content: "count these tokens" }]) > 0, true);
});

test("Groq and Ollama route through the OpenAI-compatible adapter", async () => {
  const requestUrls: string[] = [];
  const fetcher = mockFetch(async (request) => {
    requestUrls.push(request.url);
    return jsonResponse({
      id: "completion-2",
      object: "chat.completion",
      created: 2,
      model: "test-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });
  const groq = new GroqProvider({ provider: "groq", apiKey: "test-groq-key", fetcher });
  const ollama = new LLMClient({
    provider: "ollama",
    baseUrl: "http://ollama:11434/v1",
    fetcher,
  });

  const groqResult = await groq.chat([], [], "system");
  const ollamaResult = await ollama.chat([], [], "system");

  assert.equal(groqResult.ok, true);
  assert.equal(ollamaResult.ok, true);
  assert.match(requestUrls[0] ?? "", /^https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.match(requestUrls[1] ?? "", /^http:\/\/ollama:11434\/v1\/chat\/completions/);
});