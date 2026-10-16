import { z } from "zod";
import type { Sandbox } from "../sandbox.js";
import { fromSandboxResult, Tool, type ToolResult } from "./tool.js";

const listFilesSchema = z.object({
  path: z.string().trim().max(4_096).optional().describe("Workspace directory to list; omit this or use . for the repository root"),
}).strict();

const findFilesSchema = z.object({
  directory: z.string().trim().min(1).max(4_096).default(".").describe("Workspace directory to search"),
  glob: z.string().trim().min(1).max(256).default("**/*").describe("Simple glob: *, **, and ? wildcards"),
  max_results: z.number().int().min(1).max(50).default(30).describe("Maximum matching paths to return"),
}).strict();

const searchFilesSchema = z.object({
  query: z.string().min(1).max(1_000).describe("Literal text to find; this is not a regular expression"),
  directory: z.string().trim().min(1).max(4_096).default(".").describe("Workspace directory to search"),
  glob: z.string().trim().min(1).max(256).default("**/*").describe("Simple glob: *, **, and ? wildcards"),
  case_sensitive: z.boolean().default(false).describe("Whether the literal search is case sensitive"),
  max_results: z.number().int().min(1).max(30).default(15).describe("Maximum matching lines to return"),
}).strict();

export class ListFilesTool extends Tool<typeof listFilesSchema> {
  readonly name = "list_files";
  readonly description = "List up to 200 project files, excluding generated and dependency directories. Omit path to list the repository root.";
  protected readonly schema = listFilesSchema;

  protected async executeValidated(
    args: z.output<typeof listFilesSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    return fromSandboxResult(await sandbox.listFiles(args.path || "."));
  }
}

export class FindFilesTool extends Tool<typeof findFilesSchema> {
  readonly name = "find_files";
  readonly description = "Find workspace files by a simple glob (*, **, ?) within a directory; returns at most 50 paths.";
  protected readonly schema = findFilesSchema;

  protected async executeValidated(
    args: z.output<typeof findFilesSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    const listed = await sandbox.listFiles(args.directory);
    if (!listed.ok) return { success: false, output: listed.error };
    const paths = listed.data.split(/\r?\n/).map(workspaceRelativePath).filter(Boolean);
    const matcher = globMatcher(args.glob);
    const matches = paths.filter((filePath) => matcher.test(filePath)).slice(0, args.max_results);
    const capped = paths.length >= 200 ? "The sandbox listing reached its 200-file limit; narrow the directory to search further." : "";
    return {
      success: true,
      output: [matches.join("\n") || "No files matched the glob.", capped].filter(Boolean).join("\n"),
    };
  }
}

export class SearchFilesTool extends Tool<typeof searchFilesSchema> {
  readonly name = "search_files";
  readonly description = "Find literal text occurrences in workspace files filtered by directory and simple glob; does not execute a regular expression.";
  protected readonly schema = searchFilesSchema;

  protected async executeValidated(
    args: z.output<typeof searchFilesSchema>,
    sandbox: Sandbox,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) return { success: false, output: "File search cancelled before scanning began." };
    const listed = await sandbox.listFiles(args.directory);
    if (!listed.ok) return { success: false, output: listed.error };
    const matcher = globMatcher(args.glob);
    const paths = listed.data.split(/\r?\n/)
      .map(workspaceRelativePath)
      .filter((filePath) => matcher.test(filePath));
    const needle = args.case_sensitive ? args.query : args.query.toLowerCase();
    const matches: string[] = [];
    let unreadableCount = 0;

    for (const filePath of paths) {
      if (matches.length >= args.max_results) break;
      if (signal?.aborted) {
        return {
          success: false,
          output: [matches.join("\n") || "No matches found before cancellation.", "File search cancelled."].join("\n"),
        };
      }
      const file = await sandbox.readFile(filePath);
      if (!file.ok) {
        unreadableCount += 1;
        continue;
      }
      const lines = file.data.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const candidate = args.case_sensitive ? line : line.toLowerCase();
        if (!candidate.includes(needle)) continue;
        matches.push(`${filePath}:${index + 1}: ${line.slice(0, 300)}`);
        if (matches.length >= args.max_results) break;
      }
    }

    const notes = [
      paths.length >= 200 ? "The sandbox listing reached its 200-file limit; narrow the directory to search further." : "",
      unreadableCount ? `${unreadableCount} matching file(s) could not be read.` : "",
    ].filter(Boolean);
    const output = [matches.join("\n") || "No matching text found.", ...notes].join("\n");
    return { success: true, output: output.slice(0, 12_000) };
  }
}

function workspaceRelativePath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/");
  return normalized.startsWith("/workspace/") ? normalized.slice("/workspace/".length) : normalized;
}

function globMatcher(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}
