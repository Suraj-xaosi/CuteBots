import type { ErrorRequestHandler, RequestHandler } from "express";
import { ErrorCode } from "@workspace/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "Route not found" });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "P2025") {
      response.status(404).json({ error: "Resource not found", code: ErrorCode.TASK_NOT_FOUND });
      return;
    }
    if (code === "P2002") {
      response.status(409).json({ error: "Resource already exists", code: ErrorCode.TOOL_EXECUTION_FAILED });
      return;
    }
  }
  response.status(500).json({ error: "Internal server error", code: ErrorCode.TOOL_EXECUTION_FAILED });
};