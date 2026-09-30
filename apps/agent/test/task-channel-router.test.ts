import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AgentLogEvent } from "@workspace/core";
import { HumanReplyInbox, SSEBroker } from "@workspace/core";
import { createTaskChannelRouter } from "../src/task-channel-router.js";

async function withServer<T>(handler: (baseUrl: string) => Promise<T>): Promise<T> {
  const inbox = new HumanReplyInbox();
  const logs: AgentLogEvent[] = [
    { id: 1, taskId: "task-1", type: "status", content: "before cursor", createdAt: new Date(1) },
    { id: 2, taskId: "task-1", type: "tool_result", content: "after cursor", createdAt: new Date(2) },
  ];
  const broker = new SSEBroker({
    listLogsAfter: async (taskId, afterId, limit) => ({
      ok: true,
      data: logs.filter((log) => log.taskId === taskId && log.id > afterId).slice(0, limit),
    }),
  });
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", createTaskChannelRouter(broker, inbox, {
    exists: async (taskId) => taskId === "task-1",
    isRunning: async (taskId) => taskId === "task-1",
  }));
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("task stream replays only rows after Last-Event-ID", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/stream`, {
      headers: { "Last-Event-ID": "1" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body?.getReader();
    assert.ok(reader);
    let output = "";
    while (!output.includes("after cursor")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    assert.match(output, /id: 2/);
    assert.match(output, /after cursor/);
    assert.doesNotMatch(output, /before cursor/);
    await reader.cancel();
  });
});

test("task reply route validates activity and delivers the reply", async () => {
  await withServer(async (baseUrl) => {
    const inbox = new HumanReplyInbox();
    const logs: AgentLogEvent[] = [];
    const broker = new SSEBroker({
      listLogsAfter: async () => ({ ok: true, data: logs }),
    });
    const app = express();
    app.use(express.json());
    app.use("/api/tasks", createTaskChannelRouter(broker, inbox, {
      exists: async () => true,
      isRunning: async (taskId) => taskId === "task-1",
    }));
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const waiting = inbox.waitForReply("task-1", 5_000);
      const accepted = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-1/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "Use the existing interface" }),
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await waiting, { ok: true, data: "Use the existing interface" });

      const inactive = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-2/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "No" }),
      });
      assert.equal(inactive.status, 404);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

test("task stream rejects malformed cursors", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/stream`, {
      headers: { "Last-Event-ID": "not-an-id" },
    });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  });
});