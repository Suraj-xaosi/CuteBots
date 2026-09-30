import express, { type Router } from "express";
import { z } from "zod";
import type { ProjectService } from "../services/project-service.js";
import type { TaskService } from "../services/task-service.js";
import { parseId, parseRequest } from "../http/validation.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repo_url: z.string().url().max(2_000),
  github_token: z.string().min(8).max(500).optional(),
  clone_credential: z.string().min(1).max(500).optional(),
  sandbox_type: z.literal("node").optional(),
}).strict();

const createTaskSchema = z.object({
  description: z.string().trim().min(1).max(20_000),
}).strict();

export function createProjectRouter(projects: ProjectService, tasks: TaskService): Router {
  const router = express.Router();

  router.get("/", async (_request, response) => {
    response.json({ projects: await projects.list() });
  });

  router.post("/", async (request, response) => {
    const input = parseRequest(createProjectSchema, request.body);
    const project = await projects.create(input);
    response.status(201).json({ project });
  });

  router.get("/:projectId/tasks", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      response.status(400).json({ error: "limit must be an integer from 1 to 100" });
      return;
    }
    const cursor = request.query.cursor === undefined ? undefined : parseId(String(request.query.cursor), "cursor");
    response.json({ tasks: await tasks.list(projectId, limit, cursor) });
  });

  router.post("/:projectId/tasks", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    const { description } = parseRequest(createTaskSchema, request.body);
    const result = await tasks.create(projectId, description);
    response.status(202).json(result);
  });

  router.delete("/:projectId", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    await tasks.cancelProjectTasks(projectId);
    await projects.destroy(projectId);
    response.status(204).end();
  });

  return router;
}