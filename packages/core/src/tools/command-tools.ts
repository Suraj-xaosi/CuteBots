import { z } from "zod";
import type { CommandJobSnapshot, Sandbox } from "../sandbox.js";
import { Tool, type ToolResult } from "./tool.js";

const commandSchema = z.object({
  command: z.string().trim().min(1).max(20_000).describe("Shell command to run inside the project sandbox"),
}).strict();

const commandJobSchema = z.object({
  job_id: z.string().uuid().describe("Opaque ID returned by run_command"),
}).strict();

export class RunCommandTool extends Tool<typeof commandSchema> {
  readonly name = "run_command";
  readonly description = "Run a shell command in the project's isolated sandbox.";
  protected readonly schema = commandSchema;

  protected async executeValidated(
    args: z.output<typeof commandSchema>,
    sandbox: Sandbox,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<ToolResult> {
    if (!runId) {
      return { success: false, output: "Command execution requires an agent run ID." };
    }

    const result = await sandbox.runCommand(args.command, { signal, runId });
    if (!result.ok) return { success: false, output: result.error };
    return commandJobResult(result.data);
  }
}

export class PollCommandTool extends Tool<typeof commandJobSchema> {
  readonly name = "poll_command";
  readonly description = "Poll a long-running sandbox command and retrieve only newly available output.";
  protected readonly schema = commandJobSchema;

  protected async executeValidated(
    args: z.output<typeof commandJobSchema>,
    sandbox: Sandbox,
    _signal?: AbortSignal,
    runId?: string,
  ): Promise<ToolResult> {
    if (!runId) {
      return { success: false, output: "Polling a command requires an agent run ID." };
    }

    const result = await sandbox.pollCommand(args.job_id, runId);
    if (!result.ok) return { success: false, output: result.error };
    return commandJobResult(result.data);
  }
}

export class CancelCommandTool extends Tool<typeof commandJobSchema> {
  readonly name = "cancel_command";
  readonly description = "Terminate the process group for a running sandbox command.";
  protected readonly schema = commandJobSchema;

  protected async executeValidated(
    args: z.output<typeof commandJobSchema>,
    sandbox: Sandbox,
    _signal?: AbortSignal,
    runId?: string,
  ): Promise<ToolResult> {
    if (!runId) {
      return { success: false, output: "Cancelling a command requires an agent run ID." };
    }

    const result = await sandbox.cancelCommand(args.job_id, runId);
    return result.ok
      ? { success: true, output: `Cancellation requested for job ${args.job_id}` }
      : { success: false, output: result.error };
  }
}
function commandJobResult(snapshot: CommandJobSnapshot) {
  const lines = [snapshot.output.trimEnd()];
  if (snapshot.status === "running") {
    lines.push(`Command is still running. Job ID: ${snapshot.jobId}. Use poll_command or cancel_command.`);
  } else if (snapshot.status === "timed_out") {
    lines.push(`Command exceeded its maximum runtime. Exit code: ${snapshot.exitCode ?? "unknown"}.`);
  } else {
    lines.push(`Command exited with code ${snapshot.exitCode ?? "unknown"}.`);
  }

  if (snapshot.outputTruncated) lines.push("Output truncated at the configured limit.");
  return {
    success: snapshot.status !== "timed_out" && snapshot.status !== "cancelled",
    output: lines.filter(Boolean).join("\n"),
  };
}
