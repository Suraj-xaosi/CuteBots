import type { ToolDefinition } from "@workspace/types";
import type { Sandbox } from "../sandbox.js";
import { AskHumanTool, type HumanInteraction } from "./ask-human-tool.js";
import { GitTool } from "./git-tool.js";
import { GitPushBroker, type GitPushService } from "./git-push-broker.js";
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
import { Tool, type ToolResult } from "./tool.js";
import { UpdatePlanTool, type AgentPlan } from "./update-plan-tool.js";
import { WebSearchTool } from "./web-search-tool.js";

export interface ToolRegistryOptions {
  taskId: string;
  repositoryUrl: string;
  githubToken?: string;
  readOnlyCloneCredential?: string;
  baseBranch?: string;
  gitPushBroker?: GitPushService;
  tavilyKey?: string;
  humanInteraction?: HumanInteraction;
  publishPlan?: (plan: AgentPlan) => Promise<void>;
  fetcher?: typeof fetch;
}

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, Tool>;
  private readonly gitTool: GitTool;

  constructor(options: ToolRegistryOptions) {
    const gitPushBroker = options.gitPushBroker ?? new GitPushBroker(options.repositoryUrl, options.githubToken);
    this.gitTool = new GitTool({
      repositoryUrl: options.repositoryUrl,
      taskId: options.taskId,
      githubToken: options.githubToken,
      readOnlyCloneCredential: options.readOnlyCloneCredential,
      pushBroker: gitPushBroker,
      humanInteraction: options.humanInteraction,
      baseBranch: options.baseBranch,
      fetcher: options.fetcher,
    });
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
      new UpdatePlanTool(options.publishPlan ?? (async () => {
        throw new Error("Plan updates are unavailable for this task");
      })),
      this.gitTool,
      new WebSearchTool(options.tavilyKey, options.fetcher),
      new AskHumanTool(options.humanInteraction),
    ];
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  setVerifiedDeliveryEvidence(evidence?: string, changedFiles: string[] = []): void {
    this.gitTool.setVerifiedEvidence(evidence, changedFiles);
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