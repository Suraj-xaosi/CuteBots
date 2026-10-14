import {
  AgentLoop,
  AgentLoopManager,
  ContainerManager,
  GitTool,
  LLMClient,
  ToolRegistry,
  UIChannel,
  type AgentExecutor,
  type AgentTask,
} from "@workspace/core";
import { ErrorCode, TaskStatus, type ProviderName, type Result } from "@workspace/types";
import { PrismaAgentPersistence, PrismaClient, SecretVault } from "@workspace/db";
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
      dependencies.persistence,
    );
  }

  private async createLoop(task: AgentTask): Promise<AgentLoop> {
    const project = await this.dependencies.prisma.project.findUnique({ where: { id: task.projectId } });
    if (!project) throw new Error("Project not found");
    if (project.setup_status !== "READY") {
      throw new Error("Project environment setup has not completed; the task cannot start safely");
    }

    let sandbox = this.dependencies.containers.get(project.id);
    if (!sandbox.ok) {
      const recovered = await this.dependencies.containers.recover(
        project.id,
        project.sandbox_type === "minimal" ? "minimal" : "node",
      );
      if (!recovered.ok) throw new Error(recovered.error);
      sandbox = this.dependencies.containers.get(project.id);
    }
    if (!sandbox.ok) throw new Error(sandbox.error);

    const providerName = unwrap(await this.dependencies.settings.getResolved("LLM_PROVIDER")) as ProviderName | undefined;
    if (!providerName || !isProviderName(providerName)) throw new Error("LLM_PROVIDER is not configured");
    const apiKey = unwrap(await this.dependencies.settings.getResolved("LLM_API_KEY"));
    const model = unwrap(await this.dependencies.settings.getResolved("LLM_MODEL"));
    const provider = new LLMClient({ provider: providerName, apiKey, model });

    const githubToken = project.github_token ? new SecretVault().decrypt(project.github_token) : undefined;
    const readOnlyCloneCredential = project.clone_credential
      ? new SecretVault().decrypt(project.clone_credential)
      : undefined;
    const baseBranch = process.env.GITHUB_BASE_BRANCH?.trim() || undefined;
    const gitTool = new GitTool({
      repositoryUrl: project.repo_url,
      taskId: task.id,
      githubToken,
      readOnlyCloneCredential,
      baseBranch,
    });

    if (!task.resume) {
      const prepared = await gitTool.prepareWorkspace(sandbox.data, project.workspace_ready);
      if (!prepared.success) throw new Error(prepared.output);
      if (!project.workspace_ready) {
        await this.dependencies.prisma.project.update({
          where: { id: project.id },
          data: { workspace_ready: true },
        });
      }
    }

    const uiChannel = new UIChannel(task.id, this.dependencies.persistence, this.dependencies.sseBroker, this.dependencies.replies);
    const channel = uiChannel;
    const registry = new ToolRegistry({
      humanInteraction: channel,
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
      await this.persistence.appendLog({ taskId: this.task.id, type: "error", content: reason });
    }
  }

  stop(): void {
    this.stopped = true;
    this.loop?.stop();
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function isProviderName(value: string): value is ProviderName {
  return value === "anthropic" || value === "openai" || value === "groq" || value === "ollama";
}
