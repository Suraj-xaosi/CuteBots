import assert from "node:assert/strict";
import test from "node:test";

import { TaskService } from "../src/services/task-service.js";

test("task usage summary returns aggregate token counts for a task", async () => {
  const prisma = {
    task: {
      findUnique: async () => ({
        id: "task-usage",
        token_usage: [
          { input_tokens: 110, output_tokens: 90, created_at: new Date("2024-01-01T00:00:00Z") },
          { input_tokens: 40, output_tokens: 10, created_at: new Date("2024-01-01T00:00:01Z") },
        ],
      }),
    },
  } as any;

  const service = new TaskService(prisma, { enqueue: () => ({ ok: true, data: { queued: false, position: 0 } }), cancel: () => ({ ok: true, data: undefined }), }, { submit: () => ({ ok: true, data: "ok" }) });

  const summary = await service.getUsage("task-usage");
  assert.equal(summary.taskId, "task-usage");
  assert.equal(summary.input_tokens, 150);
  assert.equal(summary.output_tokens, 100);
  assert.equal(summary.total_tokens, 250);
});
