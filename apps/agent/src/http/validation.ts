import type { ZodType } from "zod";
import { ErrorCode } from "@workspace/types";
import { ApiError } from "./api-error.js";

export function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      400,
      ErrorCode.TOOL_EXECUTION_FAILED,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

export function parseId(value: string | string[] | undefined, label = "id"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new ApiError(400, ErrorCode.TOOL_EXECUTION_FAILED, `Invalid ${label}`);
  }
  return value;
}