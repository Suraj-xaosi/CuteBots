import {
  AgentLoop,
  AgentLoopManager,
  ContextManager,
  ContainerManager,
  GitTool,
  LLMClient,
  Mem0MemoryStore,
  MemoryManager,
  TaskChannel,
  TelegramChannel,
  TelegramGateway,
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
  telegram: TelegramGateway;
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

    const githubToken = project.github_token ? new SecretVault().decrypt(project.github_token) : undefined;
    const readOnlyCloneCredential = project.clone_credential
      ? new SecretVault().decrypt(project.clone_credential)
      : undefined;
    const gitTool = new GitTool({
      repositoryUrl: project.repo_url,
      taskId: task.id,
      githubToken,
      readOnlyCloneCredential,
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

    const tavilyKey = unwrap(await this.dependencies.settings.getResolved("TAVILY_KEY"));
    const uiChannel = new UIChannel(task.id, this.dependencies.persistence, this.dependencies.sseBroker, this.dependencies.replies);
    const channel = new TaskChannel(uiChannel, new TelegramChannel(task.id, this.dependencies.telegram));
    const registry = new ToolRegistry({
      taskId: task.id,
      repositoryUrl: project.repo_url,
      githubToken,
      readOnlyCloneCredential,
      tavilyKey,
      humanInteraction: channel,
    });

    const memory = await this.createMemoryManager(providerName, apiKey, model);
    const context = new ContextManager(provider, memory);
    return new AgentLoop(
      this.dependencies.persistence,
      provider,
      context,
      registry,
      sandbox.data,
      memory,
      { channel },
    );
  }

  private async createMemoryManager(
    providerName: ProviderName,
    apiKey: string | undefined,
    model: string | undefined,
  ): Promise<MemoryManager | undefined> {
    const llmProvider = unwrap(await this.dependencies.settings.getResolved("MEMORY_LLM_PROVIDER")) ?? providerName;
    const llmKey = unwrap(await this.dependencies.settings.getResolved("MEMORY_LLM_API_KEY")) ?? apiKey;
    const llmModel = unwrap(await this.dependencies.settings.getResolved("MEMORY_LLM_MODEL")) ?? model ?? defaultModel(providerName);
    const embedderProvider = unwrap(await this.dependencies.settings.getResolved("MEMORY_EMBEDDER_PROVIDER")) ?? "openai";
    const embedderKey = unwrap(await this.dependencies.settings.getResolved("MEMORY_EMBEDDER_API_KEY")) ?? process.env.OPENAI_API_KEY;
    const embedderModel = unwrap(await this.dependencies.settings.getResolved("MEMORY_EMBEDDER_MODEL")) ?? "text-embedding-3-small";

    if (!isMemoryProvider(llmProvider) || !isMemoryProvider(embedderProvider)) return undefined;
    if (llmProvider !== "ollama" && !llmKey) return undefined;
    if (embedderProvider !== "ollama" && !embedderKey) return undefined;

    return new MemoryManager(new Mem0MemoryStore({
      qdrantHost: process.env.QDRANT_HOST ?? "localhost",
      qdrantPort: Number(process.env.QDRANT_PORT ?? 6333),
      historyDbPath: process.env.MEM0_HISTORY_DB_PATH,
      llm: { provider: llmProvider, apiKey: llmKey, model: llmModel },
      embedder: { provider: embedderProvider, apiKey: embedderKey, model: embedderModel },
    }));
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

function isMemoryProvider(value: string): boolean {
  return value === "openai" || value === "anthropic" || value === "groq" || value === "ollama";
}

function defaultModel(provider: ProviderName): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-5-20250929";
    case "openai": return "gpt-4.1-mini";
    case "groq": return "llama-3.3-70b-versatile";
    case "ollama": return "llama3.1";
  }
}