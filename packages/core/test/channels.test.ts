import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, TaskStatus, type Result } from "@workspace/types";
import type { AgentLogEvent, AgentPersistence, StoredAgentMessage } from "../src/agent/agent-types.js";
import { HumanReplyInbox } from "../src/channels/human-reply-inbox.js";
import { parseLastEventId, SSEBroker, type SSEClient } from "../src/channels/sse-broker.js";
import { TelegramChannel, TelegramGateway } from "../src/channels/telegram-channel.js";
import { UIChannel } from "../src/channels/ui-channel.js";

class FakeSSEClient implements SSEClient {
  writableEnded = false;
  readonly chunks: string[] = [];
  closeHandler: (() => void) | undefined;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  on(_event: "close", listener: () => void): this {
    this.closeHandler = listener;
    return this;
  }

  close(): void {
    this.writableEnded = true;
    this.closeHandler?.();
  }
}

class ChannelPersistence implements AgentPersistence {
  readonly logs: AgentLogEvent[] = [];

  async loadMessages(): Promise<Result<StoredAgentMessage[]>> {
    return { ok: true, data: [] };
  }

  async appendMessage(): Promise<Result<void>> {
    return { ok: true, data: undefined };
  }

  async updateTaskStatus(): Promise<Result<void>> {
    return { ok: true, data: undefined };
  }

  async appendLog(input: Omit<AgentLogEvent, "id" | "createdAt">): Promise<Result<AgentLogEvent>> {
    const saved = { ...input, id: this.logs.length + 1, createdAt: new Date() };
    this.logs.push(saved);
    return { ok: true, data: saved };
  }

  async listLogsAfter(taskId: string, afterId: number, limit: number): Promise<Result<AgentLogEvent[]>> {
    return { ok: true, data: this.logs.filter((log) => log.taskId === taskId && log.id > afterId).slice(0, limit) };
  }

  async recordTokenUsage(): Promise<Result<void>> {
    return { ok: true, data: undefined };
  }
}

function event(id: number, content: string): AgentLogEvent {
  return { id, taskId: "task-1", type: "status", content, createdAt: new Date(id) };
}

test("SSE replay buffers concurrent live events and deduplicates overlap by ID", async () => {
  const stored = [event(1, "first")];
  let finishReplay: (() => void) | undefined;
  let replayStarted: (() => void) | undefined;
  const waitingForReplay = new Promise<void>((resolve) => { replayStarted = resolve; });
  const persistence = {
    listLogsAfter: async (_taskId: string, afterId: number, limit: number): Promise<Result<AgentLogEvent[]>> => {
      replayStarted?.();
      await new Promise<void>((resolve) => { finishReplay = resolve; });
      return { ok: true, data: stored.filter((row) => row.id > afterId).slice(0, limit) };
    },
  };
  const broker = new SSEBroker(persistence);
  const client = new FakeSSEClient();
  const connecting = broker.subscribe("task-1", client, 0);
  await waitingForReplay;

  const second = event(2, "second");
  stored.push(second);
  broker.publish(second);
  finishReplay?.();
  await connecting;
  broker.publish(event(3, "third"));

  const output = client.chunks.join("");
  const ids = [...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal((output.match(/"content":"second"/g) ?? []).length, 1);
});

test("SSE cursor parsing accepts integers and rejects malformed IDs", () => {
  assert.deepEqual(parseLastEventId(undefined), { ok: true, data: 0 });
  assert.deepEqual(parseLastEventId("42"), { ok: true, data: 42 });
  const invalid = parseLastEventId("4x");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, ErrorCode.TOOL_EXECUTION_FAILED);
});

test("human reply inbox resolves replies, timeouts, and aborts", async () => {
  const inbox = new HumanReplyInbox();
  const waiting = inbox.waitForReply("task-1", 5_000);
  assert.equal(inbox.submit("task-1", "Use the current API").ok, true);
  assert.deepEqual(await waiting, { ok: true, data: "Use the current API" });

  const timeout = await inbox.waitForReply("task-2", 0);
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.code, ErrorCode.TASK_TIMEOUT);

  const controller = new AbortController();
  const aborted = inbox.waitForReply("task-3", 5_000, controller.signal);
  controller.abort();
  const abortResult = await aborted;
  assert.equal(abortResult.ok, false);
  if (!abortResult.ok) assert.equal(abortResult.code, ErrorCode.TASK_CANCELLED);
});

test("Telegram channel methods degrade cleanly without a bot token", async () => {
  const gateway = new TelegramGateway({}, new HumanReplyInbox());
  const channel = new TelegramChannel("task-1", gateway);

  assert.deepEqual(await gateway.start(), { ok: true, data: undefined });
  await channel.sendMessage("message");
  await channel.sendLog(event(1, "log"));
  const reply = await channel.waitForReply(10);
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.match(reply.error, /disabled/);
});

test("UIChannel stores a final message once and publishes its monotonic log event", async () => {
  const persistence = new ChannelPersistence();
  const broker = new SSEBroker(persistence);
  const client = new FakeSSEClient();
  const replayReady = broker.subscribe("task-1", client);
  await replayReady;
  const channel = new UIChannel("task-1", persistence, broker, new HumanReplyInbox());

  await channel.sendMessage("Task complete");

  assert.equal(persistence.logs.length, 1);
  assert.equal(persistence.logs[0]?.type, "message");
  assert.match(client.chunks.join(""), /^id: 1/m);
  assert.match(client.chunks.join(""), /Task complete/);
});