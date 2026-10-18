import { ErrorCode, type Result } from "@workspace/types";
import { z } from "zod";
import { Tool, type ToolResult } from "./tool.js";
import type { Sandbox } from "../sandbox.js";

const askHumanSchema = z.object({
  question: z.string().trim().min(1).max(4_000).describe("Question that requires a human decision"),
}).strict();

export interface HumanInteraction {
  ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>>;
}

const HUMAN_REPLY_TIMEOUT_MS = 10 * 60 * 1_000;

export class AskHumanTool extends Tool<typeof askHumanSchema> {
  readonly name = "ask_human";
  readonly description = "Ask the user a question and wait up to ten minutes for a reply.";
  protected readonly schema = askHumanSchema;

  constructor(private readonly interaction?: HumanInteraction) {
    super();
  }

  protected async executeValidated(
    args: z.output<typeof askHumanSchema>,
    _sandbox: Sandbox,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!this.interaction) {
      return { success: false, output: "Human questions are unavailable in this channel" };
    }

    const result = await this.interaction.ask(args.question, HUMAN_REPLY_TIMEOUT_MS, signal);
    return result.ok
      ? { success: true, output: result.data }
      : { success: false, output: result.code === ErrorCode.TASK_TIMEOUT ? "Human reply timed out" : result.error };
  }
}