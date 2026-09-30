import type { ToolDefinition } from "@workspace/types";
import type { Sandbox } from "../sandbox.js";
import { AskHumanTool, type HumanInteraction } from "./ask-human-tool.js";
import { GitTool } from "./git-tool.js";
import { GitPushBroker, type GitPushService } from "./git-push-broker.js";
import {
  CancelCommandTool,
  ListFilesTool,
  PollCommandTool,
  ReadFileTool,
  RunCommandTool,
  StrReplaceTool,
  WriteFileTool,
} from "./sandbox-tools.js";
import { Tool, type ToolResult } from "./tool.js";
import { WebSearchTool } from "./web-search-tool.js";

export interface ToolRegistryOptions {
  taskId: string;
  repositoryUrl: string;
  githubToken?: string;
  readOnlyCloneCredential?: string;
  gitPushBroker?: GitPushService;
  tavilyKey?: string;
  humanInteraction?: HumanInteraction;
  fetcher?: typeof fetch;
}

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, Tool>;

  constructor(options: ToolRegistryOptions) {
    const gitPushBroker = options.gitPushBroker ?? new GitPushBroker(options.repositoryUrl, options.githubToken);
    const tools: Tool[] = [
      new RunCommandTool(),
      new PollCommandTool(),
      new CancelCommandTool(),
      new WriteFileTool(),
      new StrReplaceTool(),
      new ReadFileTool(),
      new ListFilesTool(),
      new GitTool({
        repositoryUrl: options.repositoryUrl,
        taskId: options.taskId,
        githubToken: options.githubToken,
        readOnlyCloneCredential: options.readOnlyCloneCredential,
        pushBroker: gitPushBroker,
        fetcher: options.fetcher,
      }),
      new WebSearchTool(options.tavilyKey, options.fetcher),
      new AskHumanTool(options.humanInteraction),
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