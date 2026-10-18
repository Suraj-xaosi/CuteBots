import express, { type Router } from "express";
import { ErrorCode } from "@workspace/types";
import type { ProjectService } from "../services/project-service.js";
import { ApiError } from "../http/api-error.js";
import { parseId } from "../http/validation.js";

export function createFileRouter(projects: ProjectService): Router {
  const router = express.Router();

  router.get("/:projectId/files", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    const sandbox = await projects.getSandbox(projectId);
    if (!sandbox.ok) throw new ApiError(503, sandbox.code, sandbox.error);
    const files = await sandbox.data.listFiles(".");
    if (!files.ok) throw new ApiError(503, files.code, files.error);
    response.json({ files: files.data.split("\n").filter(Boolean) });
  });

  router.get("/:projectId/files/content", async (request, response) => {
    const projectId = parseId(request.params.projectId, "project id");
    const filePath = request.query.path;
    if (typeof filePath !== "string" || !filePath.trim() || filePath.length > 4_096) {
      throw new ApiError(400, ErrorCode.TOOL_EXECUTION_FAILED, "A valid path query parameter is required");
    }
    const sandbox = await projects.getSandbox(projectId);
    if (!sandbox.ok) throw new ApiError(503, sandbox.code, sandbox.error);
    const content = await sandbox.data.readFile(filePath);
    if (!content.ok) {
      const status = content.code === ErrorCode.CONTAINER_EXEC_FAILED ? 404 : 503;
      throw new ApiError(status, content.code, content.error);
    }
    response.type("text/plain").send(content.data);
  });

  return router;
}