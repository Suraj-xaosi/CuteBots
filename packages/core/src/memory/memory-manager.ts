import type {
  MemoryFact,
  MemoryStore,
  ProjectMemoryInput,
  ToolMemoryInput,
} from "./memory-store.js";

export type MemoryOperation =
  | "capture_task_tool_result"
  | "capture_project_summary"
  | "search_task"
  | "search_project";

export type MemoryErrorHandler = (operation: MemoryOperation, error: unknown) => void;

export class MemoryManager {
  constructor(
    private readonly store?: MemoryStore,
    private readonly onError?: MemoryErrorHandler,
  ) {}

  async captureTaskToolResult(input: ToolMemoryInput): Promise<void> {
    if (!this.store) return;
    await this.runSafely("capture_task_tool_result", () => this.store!.captureTaskToolResult(input));
  }

  async captureProjectSummary(input: ProjectMemoryInput): Promise<void> {
    if (!this.store) return;
    await this.runSafely("capture_project_summary", () => this.store!.captureProjectSummary(input));
  }

  async searchTask(taskId: string, query: string, limit = 5): Promise<MemoryFact[]> {
    if (!this.store || !query.trim()) return [];
    return this.runSafely(
      "search_task",
      () => this.store!.searchTask(taskId, query, boundedLimit(limit)),
      [],
    );
  }

  async searchProject(projectId: string, query: string, limit = 5): Promise<MemoryFact[]> {
    if (!this.store || !query.trim()) return [];
    return this.runSafely(
      "search_project",
      () => this.store!.searchProject(projectId, query, boundedLimit(limit)),
      [],
    );
  }

  private async runSafely<T>(
    operation: MemoryOperation,
    action: () => Promise<T>,
    fallback?: T,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      try {
        this.onError?.(operation, error);
      } catch {
        // Error reporting must not interfere with the agent loop.
      }
      return fallback as T;
    }
  }
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit), 10));
}