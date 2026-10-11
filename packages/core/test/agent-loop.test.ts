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
import { MemoryManager } from "../src/memory/memory-manager.js";
import type { MemoryStore } from "../src/memory/memory-store.js";
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

  async loadTokenUsage(_taskId: string): Promise<Result<{ inputTokens: number; outputTokens: number }>> {
    const usage = this.usage;
    return {
      ok: true,
      data: {
        inputTokens: usage.reduce((total, entry) => total + entry.input, 0),
        outputTokens: usage.reduce((total, entry) => total + entry.output, 0),
      },
    };
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
  readonly verificationExecutions: string[] = [];
  readonly execCommands: string[] = [];
  statusOutput = " M src/index.ts\n";
  baselineStatusOutput = "";
  packageManifest = JSON.stringify({ packageManager: "npm@10.9.8", scripts: { test: "test" } });
  testInventoryOutput = "";
  verificationExitCodes: number[] = [];
  private statusCommandCount = 0;
  readonly files = new Map<string, string>();
  afterBaselineStatus?: () => void;
  beforeCommand?: () => void;
  waitForCommand?: (signal?: AbortSignal) => Promise<CommandJobSnapshot>;

  async runCommand(command: string, options: { signal?: AbortSignal } = {}): Promise<Result<CommandJobSnapshot>> {
    const isVerification =
      command.startsWith("git status ") ||
      command.startsWith("git diff --name-only ") ||
      command.startsWith("git rev-parse HEAD") ||
      command.startsWith("git ls-files ") ||
      command.startsWith("npm --prefix ");
    (isVerification ? this.verificationExecutions : this.executions).push(command);
    if (!isVerification) this.beforeCommand?.();
    if (!isVerification && this.waitForCommand) {
      return { ok: true, data: await this.waitForCommand(options.signal) };
    }
    const isStatus = command.startsWith("git status ");
    const isTaskDiff = command.startsWith("git diff --name-only ");
    const isHeadSnapshot = command.startsWith("git rev-parse HEAD");
    const isTestFileList = command.startsWith("git ls-files ") && command.includes("*test*");
    const isManifestList = command.startsWith("git ls-files ") && !isTestFileList;
    const statusOutput = isStatus
      ? this.statusCommandCount++ === 0
        ? this.baselineStatusOutput
        : this.statusOutput
      : "";
    if (isStatus && this.statusCommandCount === 2) this.afterBaselineStatus?.();
    const exitCode = command.startsWith("npm --prefix ")
      ? this.verificationExitCodes.shift() ?? 0
      : 0;
    const output = isStatus
      ? statusOutput
      : isTaskDiff
        ? statusOutput.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean).join("\n")
      : isHeadSnapshot
        ? "a".repeat(40)
      : isTestFileList
        ? this.testInventoryOutput
        : isManifestList
        ? "package.json\n"
        : exitCode === 0
          ? "checks passed"
          : "tests failed";
    return {
      ok: true,
      data: {
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        status: "completed",
        output,
        nextOffset: output.length,
        exitCode,
        outputTruncated: false,
      },
    };
  }

  async readFile(path: string): Promise<Result<string>> {
    if (path === "package.json") return { ok: true, data: this.packageManifest };
    const contents = this.files.get(path);
    if (contents !== undefined) return { ok: true, data: contents };
    return { ok: false, error: "File not found", code: ErrorCode.TOOL_EXECUTION_FAILED };
  }

  async listFiles(): Promise<Result<string>> {
    return { ok: true, data: ["package.json", ...this.files.keys()].join("\n") };
  }

  async exec(command: string): Promise<Result<string>> {
    this.execCommands.push(command);
    return { ok: true, data: "a".repeat(40) };
  }

  async pollCommand(): Promise<Result<CommandJobSnapshot>> {
    throw new Error("Unexpected verification command poll");
  }

  async cancelCommand(): Promise<Result<void>> {
    return { ok: true, data: undefined };
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
  assert.equal(provider.calls[0]?.systemPrompt.includes("Package manager: npm."), true);
  assert.equal(persistence.usage.length, 2);
  assert.equal(events.some((event) => event.type === "tool_result"), true);
  assert.equal(persistence.logs.some((event) => event.content.includes("Verification passed: 1 check")), true);
});

test("AgentLoop does not block tool progress or task completion on memory capture", async () => {
  const persistence = new FakePersistence();
  let releaseCapture: (() => void) | undefined;
  let captureStarted: (() => void) | undefined;
  let captureFinished: (() => void) | undefined;
  const waitingForCapture = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const captureStartedPromise = new Promise<void>((resolve) => { captureStarted = resolve; });
  const captureFinishedPromise = new Promise<void>((resolve) => { captureFinished = resolve; });
  const store: MemoryStore = {
    captureTaskToolResult: async () => {
      captureStarted?.();
      await waitingForCapture;
      captureFinished?.();
    },
    captureProjectSummary: async () => undefined,
    searchTask: async () => [],
    searchProject: async () => [],
  };
  const provider = new ScriptedProvider([
    toolResponse("run_command", { command: "pwd" }),
    response({ content: "Task is complete." }),
  ]);
  const loop = new AgentLoop(
    persistence,
    provider,
    new ContextManager(provider),
    new ToolRegistry({ taskId: "task-1", repositoryUrl: "https://github.com/acme/project.git" }),
    new FakeSandbox() as unknown as Sandbox,
    new MemoryManager(store),
  );

  await loop.run(task());
  await captureStartedPromise;
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
  assert.equal(provider.calls.length, 2);

  releaseCapture?.();
  await captureFinishedPromise;
});

test("AgentLoop marks tasks unverified when no repository changes are present", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.statusOutput = "";
  const loop = makeLoop(persistence, new ScriptedProvider([response({ content: "Here is the explanation." })]), sandbox);

  await loop.run(task());

  assert.equal(
    persistence.statuses.at(-1)?.status,
    TaskStatus.UNVERIFIED,
    JSON.stringify({ statuses: persistence.statuses, logs: persistence.logs }),
  );
  assert.equal(persistence.logs.some((event) => /no workspace changes/i.test(event.content)), true);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 1);
});

test("AgentLoop excludes unchanged pre-existing workspace edits from its verification scope", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.baselineStatusOutput = " M src/index.ts\n";
  sandbox.statusOutput = sandbox.baselineStatusOutput;
  sandbox.files.set("src/index.ts", "existing edit");
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Here is the explanation." })]),
    sandbox,
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.UNVERIFIED);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 1);
});

test("AgentLoop verifies a task that further changes a pre-existing dirty file", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.baselineStatusOutput = " M src/index.ts\n";
  sandbox.statusOutput = sandbox.baselineStatusOutput;
  sandbox.files.set("src/index.ts", "before task");
  sandbox.afterBaselineStatus = () => sandbox.files.set("src/index.ts", "changed by task");
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "The change is complete." })]),
    sandbox,
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
  assert.equal(persistence.logs.some((event) => event.content.includes("src/index.ts")), true);
});

test("AgentLoop repairs verification failures and only completes after a passing gate", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.verificationExitCodes = [0, 1, 0];
  const provider = new ScriptedProvider([
    response({ content: "The change is complete." }),
    toolResponse("run_command", { command: "fix-the-test" }, "repair"),
    response({ content: "The test is fixed." }),
  ]);
  const loop = makeLoop(persistence, provider, sandbox);

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 3);
  assert.equal(persistence.logs.some((event) => event.content.includes("FAIL npm --prefix")), true);
});

test("AgentLoop fails after bounded verification repair attempts", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.verificationExitCodes = [0, 1];
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Done." })]),
    sandbox,
    { verificationRepairAttempts: 0 },
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /Verification failed/);
});

test("AgentLoop reports baseline failures as unverified instead of blaming the task", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.verificationExitCodes = [1, 1];
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "The requested change is complete." })]),
    sandbox,
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.UNVERIFIED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /already failed at task start/);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 2);
});

test("AgentLoop reports changed code as unverified when no checks are configured", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.packageManifest = JSON.stringify({ packageManager: "npm@10.9.8", scripts: {} });
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "The requested change is complete." })]),
    sandbox,
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.UNVERIFIED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /No test, typecheck, lint, or build script/);
});

test("AgentLoop prevents task changes from replacing the configured verification script", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.statusOutput = " M package.json\n";
  sandbox.afterBaselineStatus = () => {
    sandbox.packageManifest = JSON.stringify({
      packageManager: "npm@10.9.8",
      scripts: { test: "echo bypassed" },
    });
  };
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Done." })]),
    sandbox,
    { verificationRepairAttempts: 0 },
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 1);
  assert.equal(persistence.logs.some((event) => event.content.includes("test verification script changed")), true);
});

test("AgentLoop blocks removal of existing tests and persists a structured evidence report", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const testSource = "import assert from 'node:assert';\ntest('keeps coverage', () => { assert.equal(1, 1); });\n";
  sandbox.files.set("src/index.test.ts", testSource);
  sandbox.testInventoryOutput = "src/index.test.ts\n";
  sandbox.statusOutput = " M src/index.test.ts\n";
  sandbox.afterBaselineStatus = () => sandbox.files.delete("src/index.test.ts");
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Done." })]),
    sandbox,
    { verificationRepairAttempts: 0 },
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.equal(persistence.logs.some((event) => /test source file with existing tests was removed/i.test(event.content)), true);
  const evidenceEvent = persistence.logs.find((event) => event.type === "evidence");
  assert.ok(evidenceEvent);
  const report = JSON.parse(evidenceEvent.content) as {
    status: TaskStatus;
    verification: { status: string; skippedChecks: string[] };
    fingerprints: { configSha256: string };
    changedFiles: Array<{ path: string; risk: string }>;
  };
  assert.equal(report.status, TaskStatus.FAILED);
  assert.equal(report.verification.status, "failed");
  assert.equal(report.verification.skippedChecks.length, 1);
  assert.match(report.fingerprints.configSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.changedFiles, [{ path: "src/index.test.ts", risk: "high" }]);
});

test("AgentLoop includes gate evidence in task-created commits", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([
    toolResponse("git_operation", { operation: "commit", message: "fix: requested issue" }),
    response({ content: "The verified change is committed." }),
  ]);
  const loop = makeLoop(persistence, provider, sandbox);

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
  const commitCommand = sandbox.execCommands.find((command) => command.includes("git commit"));
  assert.match(commitCommand ?? "", /Verification evidence/);
  assert.match(commitCommand ?? "", /Verification status: passed/);
});

test("AgentLoop blocks credential files before running repository scripts", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  sandbox.statusOutput = "?? .env\n";
  sandbox.files.set(".env", "API_KEY=do-not-report-this-secret-value");
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Done." })]),
    sandbox,
    { verificationRepairAttempts: 0 },
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.equal(sandbox.verificationExecutions.filter((command) => command.startsWith("npm --prefix ")).length, 1);
  assert.equal(persistence.logs.some((event) => event.content.includes("do-not-report-this-secret-value")), false);
  assert.equal(persistence.logs.some((event) => event.content.includes("Credential/private-key files")), true);
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

test("AgentLoop honors provider Retry-After for rate limits", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    { ...failure(ErrorCode.LLM_RATE_LIMIT, "rate limited"), retryAfterMs: 12_500 },
    response({ content: "Completed after the retry." }),
  ]);
  const delays: number[] = [];
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {
    retryCount: 2,
    rateLimitDelayMs: 60_000,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await loop.run(task());

  assert.deepEqual(delays, [12_500]);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
});

test("AgentLoop caps excessive Retry-After delays", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    { ...failure(ErrorCode.LLM_RATE_LIMIT, "rate limited"), retryAfterMs: 60 * 60 * 1_000 },
    response({ content: "Completed after the retry." }),
  ]);
  const delays: number[] = [];
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {
    retryCount: 2,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await loop.run(task());

  assert.deepEqual(delays, [5 * 60 * 1_000]);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
});

test("AgentLoop does not retry permanent provider request errors", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    failure(ErrorCode.LLM_REQUEST_ERROR, "bad request"),
  ]);
  const delays: number[] = [];
  const loop = makeLoop(persistence, provider, new FakeSandbox(), {
    retryCount: 3,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await loop.run(task());

  assert.equal(provider.calls.length, 1);
  assert.deepEqual(delays, []);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
});

test("AgentLoop fails empty responses and pauses at the iteration limit", async () => {
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
  assert.equal(limitPersistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(limitPersistence.statuses.at(-1)?.reason ?? "", /maximum iteration count/);
});

test("AgentLoop pauses before executing a response that exceeds its persisted token budget", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([
    toolResponse("run_command", { command: "npm test" }),
  ]);
  const loop = makeLoop(persistence, provider, sandbox, { maxTotalTokens: 10 });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /budget reached.*tokens/);
  assert.deepEqual(sandbox.executions, []);
  assert.deepEqual(persistence.usage, [{ input: 10, output: 4 }]);
  assert.equal(
    persistence.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1"),
    true,
  );
});

test("AgentLoop includes usage from earlier runs when enforcing the token budget", async () => {
  const persistence = new FakePersistence();
  persistence.usage.push({ input: 60, output: 20 });
  const loop = makeLoop(
    persistence,
    new ScriptedProvider([response({ content: "Done." })]),
    new FakeSandbox(),
    { maxTotalTokens: 90 },
  );

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /tokens 94\/90/);
});

test("AgentLoop pauses on estimated cost and persists complete non-executed tool results", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([
    toolResponse("run_command", { command: "npm test" }),
  ]);
  const loop = makeLoop(persistence, provider, sandbox, {
    maxCostUsd: 0.00015,
    inputCostPerMillionUsd: 10,
    outputCostPerMillionUsd: 20,
  });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /estimated cost \$0\.000180\/\$0\.000150/);
  assert.deepEqual(sandbox.executions, []);
  assert.equal(persistence.messages.some((message) =>
    message.role === "tool" && message.toolCallId === "call-1" && message.content.includes("budget"),
  ), true);
});

test("AgentLoop completes tool-call history when cancellation interrupts a tool batch", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([
    response({
      content: null,
      tool_calls: [
        { id: "call-first", name: "run_command", arguments: { command: "sleep" } },
        { id: "call-second", name: "run_command", arguments: { command: "npm test" } },
      ],
      finish_reason: "tool_use",
    }),
  ]);
  let started: (() => void) | undefined;
  const commandStarted = new Promise<void>((resolve) => { started = resolve; });
  sandbox.waitForCommand = (signal) => new Promise((resolve) => {
    started?.();
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

  const toolResults = persistence.messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolResults.map((message) => message.toolCallId), ["call-first", "call-second"]);
  assert.match(toolResults[1]?.content ?? "", /not executed.*cancelled/i);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.CANCELLED);
});

test("AgentLoop fails truncated responses without executing incomplete tool calls", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([
    response({
      content: "The output was cut off.",
      tool_calls: [{ id: "call-truncated", name: "run_command", arguments: { command: "npm test" } }],
      finish_reason: "length",
    }),
  ]);
  const loop = makeLoop(persistence, provider, sandbox);

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.FAILED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /incomplete.*output token limit/i);
  assert.deepEqual(sandbox.executions, []);
  assert.equal(persistence.messages.some((message) => message.role === "assistant" && message.toolCallsJson), false);
});

test("AgentLoop places repeated-command nudge after every result in a tool-call batch", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider([
    toolResponse("run_command", { command: "pwd" }, "call-1"),
    toolResponse("run_command", { command: "pwd" }, "call-2"),
    response({
      content: null,
      tool_calls: [
        { id: "call-3", name: "run_command", arguments: { command: "pwd" } },
        { id: "call-4", name: "run_command", arguments: { command: "pwd" } },
      ],
      finish_reason: "tool_use",
    }),
    response({ content: "Done." }),
  ]);
  const loop = makeLoop(persistence, provider, new FakeSandbox());

  await loop.run(task());

  const messages = provider.calls[3]?.messages ?? [];
  const resultA = messages.findIndex((message) => message.role === "tool" && message.tool_call_id === "call-3");
  const resultB = messages.findIndex((message) => message.role === "tool" && message.tool_call_id === "call-4");
  const nudge = messages.findIndex((message) =>
    message.role === "user" && message.content.includes("repeated three times"),
  );
  assert.ok(resultA >= 0);
  assert.ok(resultB > resultA);
  assert.ok(nudge > resultB);
});

test("AgentLoop resets repeated-command protection after a different command", async () => {
  const persistence = new FakePersistence();
  const commands = ["pwd", "pwd", "npm test", "pwd", "pwd", "pwd"];
  const provider = new ScriptedProvider([
    ...commands.map((command, index) => toolResponse("run_command", { command }, `call-${index + 1}`)),
    response({ content: "Completed all requested checks." }),
  ]);
  const sandbox = new FakeSandbox();
  const loop = makeLoop(persistence, provider, sandbox, { maxIterations: 8 });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.DONE);
  assert.deepEqual(sandbox.executions, commands);
});

test("AgentLoop stops repeating commands and asks for a different approach", async () => {
  const persistence = new FakePersistence();
  const provider = new ScriptedProvider(Array.from({ length: 5 }, () => toolResponse("run_command", { command: "pwd" })));
  const sandbox = new FakeSandbox();
  const loop = makeLoop(persistence, provider, sandbox, { maxIterations: 6 });

  await loop.run(task());

  assert.equal(sandbox.executions.length, 4);
  assert.equal(persistence.messages.some((message) => message.content.includes("repeated three times")), true);
  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.PAUSED);
  assert.match(persistence.statuses.at(-1)?.reason ?? "", /five times without progress/);
  assert.equal(
    persistence.messages.some((message) =>
      message.role === "tool" &&
      message.toolCallId === "call-1" &&
      message.content.includes("repeated-command guard"),
    ),
    true,
  );
});

test("AgentLoop cancels when ask_human times out", async () => {
  const persistence = new FakePersistence();
  const sandbox = new FakeSandbox();
  const provider = new ScriptedProvider([response({
    content: null,
    tool_calls: [
      { id: "human-question", name: "ask_human", arguments: { question: "Should I continue?" } },
      { id: "after-question", name: "run_command", arguments: { command: "npm test" } },
    ],
    finish_reason: "tool_use",
  })]);
  const loop = makeLoop(persistence, provider, sandbox, {}, {
    ask: async () => ({ ok: false, error: "Human reply timed out", code: ErrorCode.TASK_TIMEOUT }),
  });

  await loop.run(task());

  assert.equal(persistence.statuses.at(-1)?.status, TaskStatus.CANCELLED);
  assert.deepEqual(sandbox.executions, []);
  assert.deepEqual(
    persistence.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ["human-question", "after-question"],
  );
  assert.match(persistence.messages.at(-1)?.content ?? "", /human reply timed out/i);
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

test("AgentLoop stop aborts an active provider request and marks the task cancelled", async () => {
  const persistence = new FakePersistence();
  let requestStartedResolve: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
  let requestSignal: AbortSignal | undefined;
  const provider = new class extends ScriptedProvider {
    constructor() {
      super([]);
    }

    override chat(
      _messages: LLMMessage[],
      _tools: ToolDefinition[],
      _systemPrompt: string,
      signal?: AbortSignal,
    ): Promise<Result<LLMResponse>> {
      requestSignal = signal;
      requestStartedResolve?.();
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(failure(ErrorCode.LLM_API_ERROR, "Provider request aborted"));
        }, { once: true });
      });
    }
  }();
  const loop = makeLoop(persistence, provider, new FakeSandbox());
  const running = loop.run(task());

  await requestStarted;
  loop.stop();
  await running;

  assert.equal(requestSignal?.aborted, true);
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