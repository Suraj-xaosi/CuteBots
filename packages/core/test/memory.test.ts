import assert from "node:assert/strict";
import test from "node:test";
import type { LLMMessage, LLMProvider, LLMResponse, Result, ToolDefinition } from "@workspace/types";
import type { Memory } from "mem0ai/oss";
import { ContextManager } from "../src/memory/context-manager.js";
import { Mem0MemoryStore } from "../src/memory/mem0-store.js";
import { MemoryManager } from "../src/memory/memory-manager.js";
import type { MemoryStore } from "../src/memory/memory-store.js";

const mem0Config = {
  qdrantHost: "qdrant",
  llm: { provider: "openai", apiKey: "test-key", model: "gpt-4.1-mini" },
  embedder: { provider: "openai", apiKey: "test-key", model: "text-embedding-3-small" },
};

test("Mem0 keeps task and project facts in separate Qdrant scopes", async () => {
  const additions: Array<{ messages: unknown; options: unknown }> = [];
  const searches: Array<{ query: string; options: unknown }> = [];
  const memory = {
    add: async (messages: unknown, options: unknown) => {
      additions.push({ messages, options });
      return { results: [] };
    },
    search: async (query: string, options: unknown) => {
      searches.push({ query, options });
      return { results: [{ id: "fact-1", memory: "Uses pnpm", score: 0.9 }] };
    },
  } as unknown as Pick<Memory, "add" | "search">;
  const store = new Mem0MemoryStore(mem0Config, memory);

  await store.captureTaskToolResult({
    projectId: "project-1",
    taskId: "task-1",
    toolName: "read_file",
    arguments: { path: "package.json" },
    success: true,
    output: "Uses pnpm",
  });
  await store.captureProjectSummary({
    projectId: "project-1",
    taskId: "task-1",
    summary: "Repository uses pnpm workspaces",
  });
  const taskFacts = await store.searchTask("task-1", "package manager", 5);
  const projectFacts = await store.searchProject("project-1", "package manager", 5);

  const taskAddOptions = additions[0]?.options as { userId: string; metadata: Record<string, string> };
  const projectAddOptions = additions[1]?.options as { userId: string; metadata: Record<string, string> };
  const taskSearchOptions = searches[0]?.options as { filters: Record<string, string> };
  const projectSearchOptions = searches[1]?.options as { filters: Record<string, string> };
  assert.equal(taskAddOptions.userId, "task:task-1");
  assert.equal(taskAddOptions.metadata.scope, "task");
  assert.equal(projectAddOptions.userId, "project:project-1");
  assert.equal(projectAddOptions.metadata.scope, "project");
  assert.equal(taskSearchOptions.filters.task_id, "task-1");
  assert.equal(projectSearchOptions.filters.project_id, "project-1");
  assert.equal(taskFacts[0]?.text, "Uses pnpm");
  assert.equal(projectFacts[0]?.id, "fact-1");
});

test("Mem0 strips secrets from tool arguments, results, and project summaries", async () => {
  const additions: unknown[] = [];
  const memory = {
    add: async (messages: unknown) => {
      additions.push(messages);
      return { results: [] };
    },
    search: async () => ({ results: [] }),
  } as unknown as Pick<Memory, "add" | "search">;
  const store = new Mem0MemoryStore(mem0Config, memory);
  const token = "ghp_123456789012345678901234567890123456";

  await store.captureTaskToolResult({
    projectId: "project-1",
    taskId: "task-1",
    toolName: "read_file",
    arguments: { api_key: "argument-secret" },
    success: true,
    output: `token=${token}`,
  });
  await store.captureProjectSummary({ projectId: "project-1", taskId: "task-1", summary: `Used ${token}` });

  const serialized = JSON.stringify(additions);
  assert.equal(serialized.includes("argument-secret"), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("***"), true);
});

test("MemoryManager treats store and error-handler failures as non-fatal", async () => {
  const failingStore: MemoryStore = {
    captureTaskToolResult: async () => { throw new Error("offline"); },
    captureProjectSummary: async () => { throw new Error("offline"); },
    searchTask: async () => { throw new Error("offline"); },
    searchProject: async () => { throw new Error("offline"); },
  };
  const errors: string[] = [];
  const manager = new MemoryManager(failingStore, (operation) => {
    errors.push(operation);
    throw new Error("logger failure");
  });

  await assert.doesNotReject(() => manager.captureTaskToolResult({
    projectId: "project-1",
    taskId: "task-1",
    toolName: "run_command",
    arguments: {},
    success: false,
    output: "offline",
  }));
  assert.deepEqual(await manager.searchProject("project-1", "fact"), []);
  assert.deepEqual(errors, ["capture_task_tool_result", "search_project"]);
});

test("ContextManager injects scoped memories and guardrails", async () => {
  const store: MemoryStore = {
    captureTaskToolResult: async () => undefined,
    captureProjectSummary: async () => undefined,
    searchTask: async () => [{ id: "task-fact", text: "express is already installed" }],
    searchProject: async () => [{ id: "project-fact", text: "uses pnpm" }],
  };
  const provider = createProvider({ maxContextTokens: 20_000, countTokens: async () => 50 });
  const context = await new ContextManager(provider, new MemoryManager(store)).build({
    projectId: "project-1",
    taskId: "task-1",
    systemPrompt: "Work on the current task",
    messages: [{ role: "user", content: "Add an endpoint" }],
  });

  assert.match(context.systemPrompt, /Project memory:\n- uses pnpm/);
  assert.match(context.systemPrompt, /Task memory:\n- express is already installed/);
  assert.match(context.systemPrompt, /Never push to main/);
  assert.match(context.systemPrompt, /untrusted reference data/);
  assert.deepEqual(context.messages, [{ role: "user", content: "Add an endpoint" }]);
  assert.equal(context.summarized, false);
});

test("ContextManager summarizes older history and keeps the latest 15 messages unchanged", async () => {
  const messages: LLMMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  })) as LLMMessage[];
  const summaryCalls: LLMMessage[][] = [];
  const provider = createProvider({
    maxContextTokens: 100,
    countTokens: async (_messages, callIndex) => callIndex === 0 ? 80 : 40,
    chat: async (input) => {
      summaryCalls.push(input);
      return successResponse({
        content: "Decided to use the existing router; endpoint remains unfinished.",
        tool_calls: [],
        usage: { input_tokens: 20, output_tokens: 10 },
        finish_reason: "stop",
      });
    },
  });
  const context = await new ContextManager(provider).build({
    projectId: "project-1",
    taskId: "task-1",
    systemPrompt: "System prompt",
    messages,
  });

  assert.equal(context.summarized, true);
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0]?.length, 3);
  assert.equal(context.messages[0]?.role, "assistant");
  assert.match(context.messages[0]?.content ?? "", /endpoint remains unfinished/);
  assert.deepEqual(context.messages.slice(-15), messages.slice(-15));
});

test("ContextManager expands the recent window to keep a tool call with all results", async () => {
  const call = {
    role: "assistant" as const,
    content: "",
    tool_calls: [
      { id: "call-a", name: "read_file", arguments: { path: "a" } },
      { id: "call-b", name: "read_file", arguments: { path: "b" } },
    ],
  };
  const messages: LLMMessage[] = [
    ...Array.from({ length: 3 }, (_, index) => ({ role: "user" as const, content: `old-${index}` })),
    call,
    { role: "tool", tool_call_id: "call-a", content: "A" },
    { role: "tool", tool_call_id: "call-b", content: "B" },
    ...Array.from({ length: 13 }, (_, index) => ({ role: "user" as const, content: `recent-${index}` })),
  ];
  const provider = createProvider({
    maxContextTokens: 100,
    countTokens: async (_messages, callIndex) => callIndex === 0 ? 80 : 40,
    chat: async () => successResponse({
      content: "Earlier work summary",
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      finish_reason: "stop",
    }),
  });
  const context = await new ContextManager(provider).build({
    projectId: "project-1",
    taskId: "task-1",
    systemPrompt: "System prompt",
    messages,
  });

  const retainedCall = context.messages.find((message) => message.role === "assistant" && message.tool_calls);
  const retainedResults = context.messages.filter((message) => message.role === "tool");
  assert.equal(retainedCall !== undefined, true);
  assert.deepEqual(retainedResults.map((message) => message.role === "tool" ? message.tool_call_id : ""), ["call-a", "call-b"]);
  assert.equal(context.messages.length >= 15, true);
});

test("ContextManager drops unresolved tool-call groups before sending history", async () => {
  const provider = createProvider({ maxContextTokens: 20_000, countTokens: async () => 10 });
  const context = await new ContextManager(provider).build({
    projectId: "project-1",
    taskId: "task-1",
    systemPrompt: "System prompt",
    messages: [
      { role: "user", content: "Start" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "missing-result", name: "run_command", arguments: { command: "pwd" } }],
      },
      { role: "user", content: "Continue after recovery" },
    ],
  });

  assert.deepEqual(context.messages, [
    { role: "user", content: "Start" },
    { role: "user", content: "Continue after recovery" },
  ]);
});

test("ContextManager preserves the full history if summarization fails", async () => {
  const messages: LLMMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  })) as LLMMessage[];
  const provider = createProvider({
    maxContextTokens: 100,
    countTokens: async (_messages, callIndex) => callIndex === 0 ? 80 : 40,
    chat: async () => ({ ok: false, error: "offline", code: "LLM_API_ERROR" as never }),
  });
  const context = await new ContextManager(provider).build({
    projectId: "project-1",
    taskId: "task-1",
    systemPrompt: "System prompt",
    messages,
  });

  assert.equal(context.summarized, false);
  assert.deepEqual(context.messages, messages);
});

function createProvider(options: {
  maxContextTokens: number;
  countTokens: (messages: LLMMessage[], callIndex: number) => Promise<number>;
  chat?: (messages: LLMMessage[]) => Promise<Result<LLMResponse>>;
}): LLMProvider {
  let countCallIndex = 0;
  return {
    name: "test-provider",
    maxContextTokens: options.maxContextTokens,
    chat: async (messages: LLMMessage[], _tools: ToolDefinition[], _systemPrompt: string) => {
      return options.chat ? options.chat(messages) : successResponse({
        content: "unused",
        tool_calls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        finish_reason: "stop",
      });
    },
    countTokens: async (messages) => options.countTokens(messages, countCallIndex++),
  };
}

function successResponse(data: LLMResponse): Result<LLMResponse> {
  return { ok: true, data };
}