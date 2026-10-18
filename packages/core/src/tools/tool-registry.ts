import type { ToolDefinition } from "@workspace/types";
import type { Sandbox } from "../sandbox.js";
import { AskHumanTool, type HumanInteraction } from "./ask-human-tool.js";
import {
  CancelCommandTool,
  FindFilesTool,
  ListFilesTool,
  PollCommandTool,
  ReadFileTool,
  RunCommandTool,
  SearchFilesTool,
  StrReplaceTool,
  WriteFileTool,
} from "./sandbox-tools.js";
import { PushChangesTool } from "./git-tool.js";
import { TavilySearchTool } from "./tavily-search-tool.js";
import { Tool, type ToolResult } from "./tool.js";

export interface ToolRegistryOptions {
  humanInteraction?: HumanInteraction;
  githubPush?: {
    token?: string;
    repositoryUrl: string;
    branchName: string;
  };
  tavilyApiKey?: string;
}

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, Tool>;

  constructor(options: ToolRegistryOptions) {
    const tools: Tool[] = [
      new RunCommandTool(),
      new PollCommandTool(),
      new CancelCommandTool(),
      new WriteFileTool(),
      new StrReplaceTool(),
      new ReadFileTool(),
      new ListFilesTool(),
      new FindFilesTool(),
      new SearchFilesTool(),
      new AskHumanTool(options.humanInteraction),
      ...(options.tavilyApiKey ? [new TavilySearchTool(options.tavilyApiKey)] : []),
      ...(options.githubPush
        ? [new PushChangesTool(
            options.githubPush.token,
            options.githubPush.repositoryUrl,
            options.githubPush.branchName,
          )]
        : []),
    ];
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition);
  }

  async execute(name: string, args: unknown, sandbox: Sandbox, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, output: `Unknown tool: ${name}` };
    return tool.execute(args, sandbox, signal);
  }
}