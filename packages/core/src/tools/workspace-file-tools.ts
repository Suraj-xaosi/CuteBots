import { z } from "zod";
import type { Sandbox } from "../sandbox.js";
import { fromSandboxResult, Tool, type ToolResult } from "./tool.js";

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
