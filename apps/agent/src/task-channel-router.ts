import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ErrorCode } from "@workspace/types";
import { HumanReplyInbox, parseLastEventId, SSEBroker, type SSEClient } from "@workspace/core";

export interface TaskChannelAccess {
  exists(taskId: string): Promise<boolean>;
  isRunning(taskId: string): Promise<boolean>;
}

export function createTaskChannelRouter(
  sseBroker: SSEBroker,
  replies: HumanReplyInbox,
  access: TaskChannelAccess,
): Router {
  const router = express.Router();

  router.get("/:taskId/stream", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const taskId = readTaskId(request);
      if (!taskId || !await access.exists(taskId)) {
        response.status(404).json({ error: "Task not found" });
        return;
      }
      const cursor = parseLastEventId(request.get("Last-Event-ID"));
      if (!cursor.ok) {
        response.status(400).json({ error: cursor.error });
        return;
      }

      response.status(200);
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      await sseBroker.subscribe(taskId, response as unknown as SSEClient, cursor.data);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:taskId/reply", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const taskId = readTaskId(request);
      if (!taskId || !await access.isRunning(taskId)) {
        response.status(404).json({ error: "Task is not waiting for a reply" });
        return;
      }
      const reply = request.body?.reply;
      if (typeof reply !== "string" || !reply.trim() || reply.length > 20_000) {
        response.status(400).json({ error: "Reply must be a non-empty string of at most 20000 characters" });
        return;
      }

      const result = replies.submit(taskId, reply);
      if (!result.ok) {
        const status = result.code === ErrorCode.TASK_NOT_FOUND ? 404 : 409;
        response.status(status).json({ error: result.error });
        return;
      }
      response.status(200).json({ status: "received" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function readTaskId(request: Request): string | undefined {
  const taskId = request.params.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}