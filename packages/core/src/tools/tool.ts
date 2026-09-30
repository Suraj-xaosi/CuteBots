import { z } from "zod";
import type { ToolDefinition } from "@workspace/types";
import type { Sandbox } from "../sandbox.js";

export interface ToolResult {
  success: boolean;
  output: string;
}

export abstract class Tool<TSchema extends z.ZodType = z.ZodType> {
  abstract readonly name: string;
  abstract readonly description: string;
  protected abstract readonly schema: TSchema;

  get definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: z.toJSONSchema(this.schema) as Record<string, unknown>,
    };
  }

  async execute(args: unknown, sandbox: Sandbox, signal?: AbortSignal): Promise<ToolResult> {
    const parsed = this.schema.safeParse(args);
    if (!parsed.success) {
      return { success: false, output: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }

    try {
      return await this.executeValidated(parsed.data, sandbox, signal);
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : "Tool execution failed",
      };
    }
  }

  protected abstract executeValidated(
    args: z.output<TSchema>,
    sandbox: Sandbox,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

export function fromSandboxResult<T>(
  result: { ok: true; data: T } | { ok: false; error: string },
): ToolResult {
  if (!result.ok) return { success: false, output: result.error };
  return {
    success: true,
    output: typeof result.data === "string" ? result.data : "Success",
  };
}

export function isCommandFailure(output: string): boolean {
  const match = output.match(/(?:^|\n)Command exited with code (-?\d+)$/);
  return match !== null && Number(match[1]) !== 0;
}