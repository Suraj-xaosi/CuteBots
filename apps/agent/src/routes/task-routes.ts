import express, { type Router } from "express";
import { z } from "zod";
import type { TaskService } from "../services/task-service.js";
import { parseId, parseRequest } from "../http/validation.js";

const replySchema = z.object({ reply: z.string().trim().min(1).max(20_000) }).strict();

export function createTaskRouter(tasks: TaskService): Router {
  const router = express.Router();

  router.get("/:taskId/usage", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    const usage = await tasks.getUsage(taskId);
    response.status(200).json(usage);
  });

  router.post("/:taskId/reply", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    const { reply } = parseRequest(replySchema, request.body);
    await tasks.reply(taskId, reply);
    response.status(200).json({ status: "received" });
  });

  router.post("/:taskId/cancel", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    await tasks.cancel(taskId);
    response.status(200).json({ status: "cancellation requested" });
  });

  router.post("/:taskId/resume", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    const result = await tasks.resume(taskId);
    response.status(202).json(result.ok ? result.data : result);
  });

  return router;
}