import assert from "node:assert/strict";
import test from "node:test";
import {
  ErrorCode,
  TaskStatus,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
  type Result,
  type ToolDefinition,
} from "@workspace/types";
import { AgentLoop, type AgentLoopOptions } from "../src/agent/agent-loop.js";
import { AgentLoopManager } from "../src/agent/agent-loop-manager.js";
import type {
  AgentChannel,
  AgentLogEvent,
  AgentPersistence,
  AgentTask,
  StoredAgentMessage,
} from "../src/agent/agent-types.js";
import { ContextManager } from "../src/memory/context-manager.js";
import type { CommandJobSnapshot, Sandbox } from "../src/sandbox.js";
import { AskHumanTool } from "../src/tools/ask-human-tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

class FakePersistence implements AgentPersistence {
  readonly messages: StoredAgentMessage[] = [];
  readonly statuses: Array<{ status: TaskStatus; reason?: string }> = [];
  readonly logs: AgentLogEvent[] = [];
  readonly usage: Array<{ input: number; output: number }> = [];

  async loadMessages(taskId: string): Promise<Result<StoredAgentMessage[]>> {
    return { ok: true, data: this.messages.filter((message) => message.taskId === taskId) };
  }

  async appendMessage(message: StoredAgentMessage): Promise<Result<void>> {
    this.messages.push(message);
    return { ok: true, data: undefined };
  }

  async updateTaskStatus(_taskId: string, status: TaskStatus, reason?: string): Promise<Result<void>> {
    this.statuses.push({ status, reason });
    return { ok: true, data: undefined };
  }

  async appendLog(input: Omit<AgentLogEvent, "id" | "createdAt">): Promise<Result<AgentLogEvent>> {
    const event = { ...input, id: this.logs.length + 1, createdAt: new Date() };
    this.logs.push(event);
    return { ok: true, data: event };
  }

  async listLogsAfter(taskId: string, afterId: number, limit: number): Promise<Result<AgentLogEvent[]>> {
    return {
      ok: true,
      data: this.logs.filter((event) => event.taskId === taskId && event.id > afterId).slice(0, limit),
    };
  }

  async recordTokenUsage(_taskId: string, inputTokens: number, outputTokens: number): Promise<Result<void>> {
    this.usage.push({ input: inputTokens, output: outputTokens });
    return { ok: true, data: undefined };
  }
}

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly maxContextTokens = 100_000;
  readonly calls: Array<{ messages: LLMMessage[]; tools: ToolDefinition[]; systemPrompt: string }> = [];

  constructor(private readonly responses: Array<Result<LLMResponse>>) {}

  async chat(messages: LLMMessage[], tools: ToolDefinition[], systemPrompt: string): Promise<Result<LLMResponse>> {
    this.calls.push({ messages, tools, systemPrompt });
    return this.responses.shift() ?? response({ content: "done", tool_calls: [], finish_reason: "stop" });
  }

  async countTokens(messages: LLMMessage[]): Promise<number> {
    return messages.reduce((total, message) => total + message.content.length, 0);
  }
}

class FakeSandbox {
  readonly executions: string[] = [];
  beforeCommand?: () => void;
  waitForCommand?: (signal?: AbortSignal) => Promise<CommandJobSnapshot>;

  async runCommand(command: string, options: { signal?: AbortSignal } = {}): Promise<Result<CommandJobSnapshot>> {
    this.executions.push(command);
    this.beforeCommand?.();
    if (this.waitForCommand) {
      return { ok: true, data: await this.waitForCommand(options.signal) };
    }
    return {
      ok: true,
      data: {
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        status: "completed",
        output: "ok",
        nextOffset: 2,
        exitCode: 0,
        outputTruncated: false,
      },
    };
  }
}

function task(id = "task-1", projectId = "project-1"): AgentTask {
  return { id, projectId, description: "Inspect the project and make the requested change" };
}

function toolResponse(name: string, args: Record<string, unknown>, id = "call-1"): Result<LLMResponse> {
  return response({
    content: null,
    tool_calls: [{ id, name, arguments: args }],
    finish_reason: "tool_use",
  });
}

function response(overrides: Partial<LLMResponse>): Result<LLMResponse> {
  return {
    ok: true,
    data: {
      content: null,
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 4 },
      finish_reason: "stop",
      ...overrides,
    },
  };
}

function failure(code: ErrorCode, error = "provider unavailable"): Result<LLMResponse> {
  return { ok: false, error, code };
}

function makeLoop(
  persistence: FakePersistence,
  provider: ScriptedProvider,
  sandbox: FakeSandbox,
  options: AgentLoopOptions = {},
  humanInteraction?: ConstructorParameters<typeof AskHumanTool>[0],
): AgentLoop {
  const context = new ContextManager(provider);
  const tools = new ToolRegistry({
    taskId: "task-1",
    repositoryUrl: "https://github.com/acme/project.git",
    humanInteraction,
  });
  return new AgentLoop(
    persistence,
    provider,
    context,
    tools,
    sandbox as unknown as Sandbox,
    undefined,
    options,
  );
}

test("AgentLoop persists assistant tool calls before execution and completes", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    toolResponse("run_command", { command: "pwd" }),
    response({ content: "The workspace is ready." }),
  ]);
  const sandbox = new FakeSandbox();
  sandbox.beforeCommand = () => {
    const savedCall = persistence.messages.find((message) => message.role === "assistant" && message.toolCallsJson);
    assert.equal(savedCall?.toolCallsJson, JSON.stringify([
      { id: "call-1", name: "run_command", arguments: { command: "pwd" } },
    ]));
  };
  const loop = makeLoop(persistence, provider, sandbox);
  const events: AgentLogEvent[] = [];
  loop.on("event", (event: AgentLogEvent) => events.push(event));

  await loop.run(task());

  assert.deepEqual(persistence.statuses.map(({ status }) => status), [TaskStatus.RUNNING, TaskStatus.DONE]);
  assert.deepEqual(sandbox.executions, ["pwd"]);
  assert.equal(persistence.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1"), true);
  assert.equal(provider.calls[0]?.systemPrompt.includes("Never push to main"), true);
  assert.equal(persistence.usage.length, 2);
  assert.equal(events.some((event) => event.type === "tool_result"), true);
});

test("AgentLoop forwards persisted log IDs and final messages to its channel", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([response({ content: "Implementation finished." })]);
  const channelEvents: AgentLogEvent[] = [];
  const channelMessages: string[] = [];
  const channel: AgentChannel = {
    sendMessage: async (message) => { channelMessages.push(message); },
    sendLog: async (event) => { channelEvents.push(event); },
    waitForReply: async () => ({ ok: true, data: "reply" }),
  };
  const loop = makeLoop(persistence, provider, new FakeSandbox(), { channel });

  await loop.run(task());

  assert.deepEqual(channelEvents.map((event) => event.id), persistence.logs.map((event) => event.id));
  assert.equal(channelEvents.length, persistence.logs.length);
  assert.deepEqual(channelMessages, ["Implementation finished."]);
  assert.equal(persistence.logs.some((event) => event.type === "message"), false);
});

test("AgentLoop reloads persisted tool-call JSON when resuming", async () => {
  const persistence = new FakePersistence();
  persistence.messages.push(
    { taskId: "task-1", projectId: "project-1", role: "user", content: "Read package.json" },
    {
      taskId: "task-1",
      projectId: "project-1",
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify([{ id: "call-resume", name: "read_file", arguments: { path: "package.json" } }]),
    },
    { taskId: "task-1", projectId: "project-1", role: "tool", content: "{}", toolCallId: "call-resume" },
  );
  const provider = new ScriptedProvider([response({ content: "The project uses npm workspaces." })]);
  const loop = makeLoop(persistence, provider, new FakeSandbox());

  await loop.run(task());

  assert.deepEqual(provider.calls[0]?.messages[1], {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-resume", name: "read_file", arguments: { path: "package.json" } }],
  });
  assert.deepEqual(provider.calls[0]?.messages[2], {
    role: "tool",
    content: "{}",
    tool_call_id: "call-resume",
  });
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
});

test("AgentLoop pauses after transient API failures exhaust retries", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    failure(ErrorCode.LLM_API_ERROR),
    failure(ErrorCode.LLM_API_ERROR),
    failure(ErrorCode.LLM_API_ERROR),
  ]);
  const delays: number[] = [];
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {
    retryCount: 3,
    apiRetryDelayMs: 10_000,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await loop.run(task());

  assert.deepEqual(delays, [10_000, 10_000]);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /provider unavailable/);
});

test("AgentLoop waits 60 seconds and retries rate limits", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    failure(ErrorCode.LLM_RATE_LIMIT, "rate limited"),
    response({ content: "Completed after the retry." }),
  ]);
  const delays: number[] = [];
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {
    retryCount: 2,
    rateLimitDelayMs: 60_000,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await loop.run(task());

  assert.deepEqual(delays, [60_000]);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
});

test("AgentLoop fails empty responses and iteration limits", async () => {
  const emptyPersistence = new FakePersistence();
  const emptyLoop = makeLoop(emptyPersistence, new ScriptedProvider([response({ content: "" })]), new FakeSandbox());
  await emptyLoop.run(task());
  assert.equal(emptyPersistence.statuses.at(-1)?.status, TaskStatus.FAILED);

  const limitPersistence = new FakePersistence();
  const limitLoop = makeLoop(
    limitPersistence,
    new ScriptedProvider([toolResponse("run_command", { command: "pwd" })]),
    new FakeSandbox(),
    { maxIterations: 1 },
  );
  await limitLoop.run(task());
  assert.equal(limitPersistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.match(limitPersistence.statuses.at(-1)?.reason ?? "", /TASK_MAX_ITER_REACHED/);
});

test("AgentLoop stops repeating commands and asks for a different approach", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider(Array.from({ length: 5 }, () => toolResponse("run_command", { command: "pwd" })));
  const sandbox = new FakeSandbox();
  const loop = makeLoop(persistence, provider, sandbox, { maxIterations: 6 });

  await loop.run(task());

  assert.equal(sandbox.executions.length, 4);
  assert.equal(persistence.messages.some((message) => message.content.includes("repeated three times")), true);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /requested five times/);
});

test("AgentLoop cancels when ask_human times out", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([toolResponse("ask_human", { question: "Should I continue?" })]);
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {}, {
    ask: async () => ({ ok: false, error: "Human reply timed out", code: ErrorCode.TASK_TIMEOUT }),
  });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.CANCELLED);
});

test("AgentLoop stop cancels an active command and marks the task cancelled", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([toolResponse("run_command", { command: "sleep 60" })]);
  const sandbox = new FakeSandbox();
  let commandStartedResolve: (() => void) | undefined;
  const commandStarted = new Promise<void>((resolve) => { commandStartedResolve = resolve; });
  sandbox.waitForCommand = (signal) => new Promise((resolve) => {
    commandStartedResolve?.();
    signal?.addEventListener("abort", () => resolve({
      jobId: "123e4567-e89b-42d3-a456-426614174000",
      status: "cancelled",
      output: "terminated",
      nextOffset: 10,
      exitCode: null,
      outputTruncated: false,
    }), { once: true });
  });
  const loop = makeLoop(persistence, provider, sandbox);
  const running = loop.run(task());

  await commandStarted;
  loop.stop();
  await running;

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.CANCELLED);
});

test("AgentLoop task timeout aborts active work and fails with TASK_TIMEOUT", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([toolResponse("run_command", { command: "sleep 60" })]);
  const sandbox = new FakeSandbox();
  sandbox.waitForCommand = (signal) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve({
      jobId: "123e4567-e89b-42d3-a456-426614174000",
      status: "cancelled",
      output: "terminated",
      nextOffset: 10,
      exitCode: null,
      outputTruncated: false,
    }), { once: true });
  });
  const loop = makeLoop(persistence, provider, sandbox, { taskTimeoutMs: 5 });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /TASK_TIMEOUT/);
});

test("AgentLoopManager serializes tasks per project and queues the next task", async () => {
  const persistence = new FakePersistence();
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let secondStartedResolve: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => { secondStartedResolve = resolve; });
  const manager = AgentLoopManager.getInstance((queuedTask) => ({
    run: async () => {
      starts.push(queuedTask.id);
      if (queuedTask.id === "task-2") secondStartedResolve?.();
      await new Promise<void>((resolve) => releases.set(queuedTask.id, resolve));
    },
    stop: () => releases.get(queuedTask.id)?.(),
  }), persistence);

  const first = manager.enqueue(task("task-1"));
  const second = manager.enqueue(task("task-2"));

  assert.equal(first.ok && first.data.queued, false);
  assert.equal(second.ok && second.data.queued, true);
  assert.deepEqual(starts, ["task-1"]);
  releases.get("task-1")?.();
  await secondStarted;
  assert.deepEqual(starts, ["task-1", "task-2"]);
  await manager.cancel("task-2");
});