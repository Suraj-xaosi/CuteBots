import { z } from "zod";
import { fromSandboxResult, Tool, type ToolResult } from "./tool.js";
import type { CommandJobSnapshot, Sandbox } from "../sandbox.js";

const commandSchema = z.object({
  command: z.string().trim().min(1).max(20_000).describe("Shell command to run inside the project sandbox"),
}).strict();

const pathSchema = z.object({
  path: z.string().trim().min(1).max(4_096).describe("Path inside the project workspace"),
}).strict();

const writeFileSchema = pathSchema.extend({
  content: z.string().describe("UTF-8 file contents"),
}).strict();

const strReplaceSchema = pathSchema.extend({
  oldText: z.string().min(1).describe("Exact existing text that must occur exactly once"),
  newText: z.string().describe("Replacement text"),
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
  ): Promise<ToolResult> {
    const result = await sandbox.runCommand(args.command, { signal });
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
  ): Promise<ToolResult> {
    const result = await sandbox.pollCommand(args.job_id);
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
  ): Promise<ToolResult> {
    const result = await sandbox.cancelCommand(args.job_id);
    return result.ok
      ? { success: true, output: `Cancellation requested for job ${args.job_id}` }
      : { success: false, output: result.error };
  }
}

export class WriteFileTool extends Tool<typeof writeFileSchema> {
  readonly name = "write_file";
  readonly description = "Write UTF-8 content to a file inside the project workspace.";
  protected readonly schema = writeFileSchema;

  protected async executeValidated(
    args: z.output<typeof writeFileSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    return fromSandboxResult(await sandbox.writeFile(args.path, args.content));
  }
}

export class ReadFileTool extends Tool<typeof pathSchema> {
  readonly name = "read_file";
  readonly description = "Read a UTF-8 file from the project workspace.";
  protected readonly schema = pathSchema;

  protected async executeValidated(
    args: z.output<typeof pathSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    return fromSandboxResult(await sandbox.readFile(args.path));
  }
}

export class ListFilesTool extends Tool<typeof pathSchema> {
  readonly name = "list_files";
  readonly description = "List up to 200 project files, excluding generated and dependency directories.";
  protected readonly schema = pathSchema;

  protected async executeValidated(
    args: z.output<typeof pathSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    return fromSandboxResult(await sandbox.listFiles(args.path));
  }
}

function commandJobResult(snapshot: CommandJobSnapshot): ToolResult {
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

export class StrReplaceTool extends Tool<typeof strReplaceSchema> {
  readonly name = "str_replace";
  readonly description = "Replace one exact text occurrence in a file; fails without writing unless it matches exactly once.";
  protected readonly schema = strReplaceSchema;

  protected async executeValidated(
    args: z.output<typeof strReplaceSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    const file = await sandbox.readFile(args.path);
    if (!file.ok) return fromSandboxResult(file);

    const firstMatch = file.data.indexOf(args.oldText);
    if (firstMatch < 0) {
      return { success: false, output: "Exact text was not found; file was not changed" };
    }
    if (file.data.indexOf(args.oldText, firstMatch + args.oldText.length) >= 0) {
      return { success: false, output: "Exact text matched more than once; file was not changed" };
    }

    return fromSandboxResult(await sandbox.writeFile(
      args.path,
      `${file.data.slice(0, firstMatch)}${args.newText}${file.data.slice(firstMatch + args.oldText.length)}`,
    ));
  }
}