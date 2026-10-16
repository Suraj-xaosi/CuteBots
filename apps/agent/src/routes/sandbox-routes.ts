import express, { type Router } from "express";
import type { ProjectService } from "../services/project-service.js";
import { parseId } from "../http/validation.js";

export function createSandboxRouter(projects: ProjectService): Router {
  const router = express.Router();

  router.post("/:projectId/sandbox/start", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    response.json({ project: await projects.startSandbox(projectId) });
  });

  router.delete("/:projectId/sandbox", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    response.json({ project: await projects.destroySandbox(projectId) });
  });

  return router;
}