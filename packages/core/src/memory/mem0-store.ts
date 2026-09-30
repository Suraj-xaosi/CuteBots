import type { Memory, MemoryConfig } from "mem0ai/oss";
import type {
  MemoryFact,
  MemoryStore,
  ProjectMemoryInput,
  ToolMemoryInput,
} from "./memory-store.js";

type Mem0Client = Pick<Memory, "add" | "search">;

export interface Mem0MemoryStoreConfig {
  qdrantHost: string;
  qdrantPort?: number;
  collectionName?: string;
  embeddingDimension?: number;
  historyDbPath?: string;
  llm: {
    provider: string;
    apiKey?: string;
    model: string;
    baseUrl?: string;
  };
  embedder: {
    provider: string;
    apiKey?: string;
    model: string;
    dimensions?: number;
    baseUrl?: string;
  };
}

export class Mem0MemoryStore implements MemoryStore {
  private memoryPromise: Promise<Mem0Client> | undefined;

  constructor(
    private readonly config: Mem0MemoryStoreConfig,
    memory?: Mem0Client,
  ) {
    if (memory) this.memoryPromise = Promise.resolve(memory);
  }

  async captureTaskToolResult(input: ToolMemoryInput): Promise<void> {
    const safeArguments = JSON.stringify(redactStructuredSecrets(input.arguments));
    const messages = [
      {
        role: "user",
        content: `Tool ${input.toolName} was called with: ${truncate(safeArguments, 4_000)}`,
      },
      {
        role: "assistant",
        content: `Tool result (success=${input.success}): ${truncate(redactTextSecrets(input.output), 8_000)}`,
      },
    ];
    await (await this.getMemory()).add(messages, {
      userId: taskUserId(input.taskId),
      metadata: {
        scope: "task",
        project_id: input.projectId,
        task_id: input.taskId,
      },
    });
  }

  async captureProjectSummary(input: ProjectMemoryInput): Promise<void> {
    await (await this.getMemory()).add(
      [{ role: "assistant", content: truncate(redactTextSecrets(input.summary), 8_000) }],
      {
        userId: projectUserId(input.projectId),
        metadata: {
          scope: "project",
          project_id: input.projectId,
          source_task_id: input.taskId,
        },
      },
    );
  }

  async searchTask(taskId: string, query: string, limit: number): Promise<MemoryFact[]> {
    const result = await (await this.getMemory()).search(query, {
      topK: limit,
      filters: { user_id: taskUserId(taskId), scope: "task", task_id: taskId },
    });
    return result.results.map((item) => ({ id: item.id, text: item.memory, score: item.score }));
  }

  async searchProject(projectId: string, query: string, limit: number): Promise<MemoryFact[]> {
    const result = await (await this.getMemory()).search(query, {
      topK: limit,
      filters: { user_id: projectUserId(projectId), scope: "project", project_id: projectId },
    });
    return result.results.map((item) => ({ id: item.id, text: item.memory, score: item.score }));
  }

  private getMemory(): Promise<Mem0Client> {
    this.memoryPromise ??= import("mem0ai/oss").then(({ Memory }) => {
      const memoryConfig: Partial<MemoryConfig> = {
        llm: {
          provider: this.config.llm.provider,
          config: {
            model: this.config.llm.model,
            temperature: 0.1,
            ...(this.config.llm.apiKey ? { apiKey: this.config.llm.apiKey } : {}),
            ...(this.config.llm.baseUrl ? { baseURL: this.config.llm.baseUrl } : {}),
          },
        },
        embedder: {
          provider: this.config.embedder.provider,
          config: {
            model: this.config.embedder.model,
            embeddingDims: this.config.embedder.dimensions ?? this.config.embeddingDimension ?? 1_536,
            ...(this.config.embedder.apiKey ? { apiKey: this.config.embedder.apiKey } : {}),
            ...(this.config.embedder.baseUrl ? { baseURL: this.config.embedder.baseUrl } : {}),
          },
        },
        vectorStore: {
          provider: "qdrant",
          config: {
            host: this.config.qdrantHost,
            port: this.config.qdrantPort ?? 6333,
            collectionName: this.config.collectionName ?? "cute-bots-memories",
            dimension: this.config.embeddingDimension ?? this.config.embedder.dimensions ?? 1_536,
          },
        },
        ...(this.config.historyDbPath ? { historyDbPath: this.config.historyDbPath } : {}),
      };
      return new Memory(memoryConfig);
    }).catch((error: unknown) => {
      this.memoryPromise = undefined;
      throw error;
    });
    return this.memoryPromise;
  }
}

function taskUserId(taskId: string): string {
  return `task:${taskId}`;
}

function projectUserId(projectId: string): string {
  return `project:${projectId}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function redactStructuredSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (typeof value === "string") return redactTextSecrets(value);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /api[_-]?key|token|password|secret/i.test(key) ? "***" : redactStructuredSecrets(entry),
  ]));
}

function redactTextSecrets(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;}{]+/gi, "$1***");
}