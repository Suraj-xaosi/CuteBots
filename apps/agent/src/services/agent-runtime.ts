import {
  AgentLoop,
  AgentLoopManager,
  ContainerManager,
  LLMClient,
  ToolRegistry,
  UIChannel,
  type AgentExecutor,
  type AgentTask,
} from "@workspace/core";
import { ErrorCode, TaskStatus, type ProviderName, type Result } from "@workspace/types";
import { PrismaClient } from "@workspace/db";
import { PrismaAgentPersistence } from "../persistence/prisma-agent-persistence.js";
import { SecretVault } from "../security/secret-vault.js";
import { SettingsService } from "./settings-service.js";
import type { SSEBroker } from "@workspace/core";
import type { HumanReplyInbox } from "@workspace/core";

export interface AgentRuntimeDependencies {
  prisma: PrismaClient;
  persistence: PrismaAgentPersistence;
  settings: SettingsService;
  containers: ContainerManager;
  sseBroker: SSEBroker;
  replies: HumanReplyInbox;
}

export class AgentRuntimeFactory {
  readonly loops: AgentLoopManager;

  constructor(private readonly dependencies: AgentRuntimeDependencies) {
    this.loops = AgentLoopManager.getInstance(
      (task) => new LazyAgentExecutor(task, () => this.createLoop(task), this.dependencies.persistence),
    );
  }

  private async createLoop(task: AgentTask) {
    const project = await this.dependencies.prisma.project.findUnique({ where: { id: task.projectId } });
    if (!project) throw new Error("Project not found");
    if (project.provision_status !== "READY") {
      throw new Error("Repository provisioning has not completed; the task cannot start safely");
    }

    let sandbox = this.dependencies.containers.get(project.id);
    if (!sandbox.ok) {
      const recovered = await this.dependencies.containers.recover(project.id);
      if (!recovered.ok) throw new Error(recovered.error);
      sandbox = this.dependencies.containers.get(project.id);
    }
    if (!sandbox.ok) throw new Error(sandbox.error);

    const providerName = unwrap(await this.dependencies.settings.getResolved("LLM_PROVIDER")) as ProviderName | undefined;
    if (!providerName || !isProviderName(providerName)) throw new Error("LLM_PROVIDER is not configured");
    const apiKey = unwrap(await this.dependencies.settings.getResolved("LLM_API_KEY"));
    const model = unwrap(await this.dependencies.settings.getResolved("LLM_MODEL"));
    const provider = new LLMClient({ provider: providerName, apiKey, model });
    const tavilyApiKey = unwrap(await this.dependencies.settings.getResolved("TAVILY_API_KEY"));

    const channel = new UIChannel(task.id, this.dependencies.persistence, this.dependencies.sseBroker, this.dependencies.replies);
    const githubToken = project.github_token
      ? new SecretVault().decrypt(project.github_token)
      : undefined;
    const registry = new ToolRegistry({
      humanInteraction: channel,
      githubPush: {
        token: githubToken,
        repositoryUrl: project.repo_url,
        branchName: task.branchName ?? project.branch_name ?? "",
      },
      ...(tavilyApiKey ? { tavilyApiKey } : {}),
    });

    return new AgentLoop(
      this.dependencies.persistence,
      provider,
      registry,
      sandbox.data,
      channel,
    );
  }
}

class LazyAgentExecutor implements AgentExecutor {
  private stopped = false;
  private loop: AgentLoop | undefined;

  constructor(
    private readonly task: AgentTask,
    private readonly createLoop: () => Promise<AgentLoop>,
    private readonly persistence: PrismaAgentPersistence,
  ) {}

  async run(): Promise<void> {
    try {
      this.loop = await this.createLoop();
      if (this.stopped) this.loop.stop();
      await this.loop.run(this.task);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unable to initialize agent task";
      await this.persistence.updateTaskStatus(this.task.id, TaskStatus.FAILED, `${ErrorCode.TOOL_EXECUTION_FAILED}: ${reason}`);
      const logged = await this.persistence.appendLog({ taskId: this.task.id, type: "error", content: reason });
      if (!logged.ok) console.error(`Unable to record initialization failure for task ${this.task.id}: ${logged.error}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.loop?.stop();
  }
}

function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function isProviderName(value: string): value is ProviderName {
  return value === "anthropic" || value === "openai" || value === "groq" || value === "ollama";
}
