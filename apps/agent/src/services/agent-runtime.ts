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
  type AgentChannel,
  type AgentLoopOptions,
  type AgentPlan,
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

    const tavilyKey = unwrap(await this.dependencies.settings.getResolved("TAVILY_KEY"));
    const uiChannel = new UIChannel(task.id, this.dependencies.persistence, this.dependencies.sseBroker, this.dependencies.replies);
    const channel = new TaskChannel(uiChannel, new TelegramChannel(task.id, this.dependencies.telegram));
    let currentPlan: AgentPlan | undefined;
    const registry = new ToolRegistry({
      taskId: task.id,
      repositoryUrl: project.repo_url,
      githubToken,
      readOnlyCloneCredential,
      baseBranch,
      tavilyKey,
      humanInteraction: channel,
      publishPlan: async (plan: AgentPlan) => {
        currentPlan = plan;
        const logged = await this.dependencies.persistence.appendLog({
          taskId: task.id,
          type: "plan",
          content: JSON.stringify(plan),
        });
        if (!logged.ok) throw new Error(`Unable to persist plan update: ${logged.error}`);
        await channel.sendLog(logged.data);
      },
    });

    const memory = await this.createMemoryManager(providerName, apiKey, model, task.id, channel);
    const context = new ContextManager(provider, memory);
    const budget = this.readAgentBudget();
    return new AgentLoop(
      this.dependencies.persistence,
      provider,
      context,
      registry,
      sandbox.data,
      memory,
      {
        channel,
        ...budget,
        currentPlan: () => currentPlan,
        modelLabel: model ?? defaultModel(providerName),
      },
    );
  }

  private readAgentBudget(): Pick<
    AgentLoopOptions,
    "maxTotalTokens" | "maxCostUsd" | "inputCostPerMillionUsd" | "outputCostPerMillionUsd"
  > {
    const tokenBudget = readOptionalNumber("AGENT_MAX_TOTAL_TOKENS");
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      throw new Error("AGENT_MAX_TOTAL_TOKENS must be a positive safe integer");
    }
    const maxCostUsd = readOptionalNumber("AGENT_MAX_COST_USD");
    const inputCostPerMillionUsd = readOptionalNumber("AGENT_INPUT_COST_PER_MILLION_USD");
    const outputCostPerMillionUsd = readOptionalNumber("AGENT_OUTPUT_COST_PER_MILLION_USD");
    if (maxCostUsd !== undefined && maxCostUsd <= 0) {
      throw new Error("AGENT_MAX_COST_USD must be positive");
    }
    if ((inputCostPerMillionUsd !== undefined && inputCostPerMillionUsd < 0) ||
      (outputCostPerMillionUsd !== undefined && outputCostPerMillionUsd < 0)) {
      throw new Error("Agent token cost rates must be non-negative");
    }
    if (maxCostUsd !== undefined &&
      (inputCostPerMillionUsd === undefined || outputCostPerMillionUsd === undefined)) {
      throw new Error("AGENT_MAX_COST_USD requires both input and output token cost rates");
    }
    return {
      ...(tokenBudget !== undefined ? { maxTotalTokens: tokenBudget } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(inputCostPerMillionUsd !== undefined ? { inputCostPerMillionUsd } : {}),
      ...(outputCostPerMillionUsd !== undefined ? { outputCostPerMillionUsd } : {}),
    };
  }

  private async createMemoryManager(
    providerName: ProviderName,
    apiKey: string | undefined,
    model: string | undefined,
    taskId: string,
    channel: AgentChannel,
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

    return new MemoryManager(
      new Mem0MemoryStore({
        qdrantHost: process.env.QDRANT_HOST ?? "localhost",
        qdrantPort: Number(process.env.QDRANT_PORT ?? 6333),
        historyDbPath: process.env.MEM0_HISTORY_DB_PATH,
        llm: { provider: llmProvider, apiKey: llmKey, model: llmModel },
        embedder: { provider: embedderProvider, apiKey: embedderKey, model: embedderModel },
      }),
      async (operation) => {
        const logged = await this.dependencies.persistence.appendLog({
          taskId,
          type: "warn",
          content: `Memory operation ${operation} failed; the agent continued without it.`,
        });
        if (!logged.ok) throw new Error(logged.error);
        await channel.sendLog(logged.data);
      },
    );
  }
}

function readOptionalNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
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