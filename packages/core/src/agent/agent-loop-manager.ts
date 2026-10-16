import { ErrorCode, type Result } from "@workspace/types";
import type { AgentTask, AgentExecutor } from "./agent-types.js";

export type AgentExecutorFactory = (task: AgentTask) => AgentExecutor;

export class AgentLoopManager {
  private static instance: AgentLoopManager | undefined;
  private readonly projects = new Map<string, { taskId: string; executor: AgentExecutor }>();

  private constructor(private readonly createExecutor: AgentExecutorFactory) {}

  static getInstance(createExecutor?: AgentExecutorFactory): AgentLoopManager {
    if (!this.instance) {
      if (!createExecutor) {
        throw new Error("AgentLoopManager must be initialized with an executor factory");
      }
      this.instance = new AgentLoopManager(createExecutor);
    }
    return this.instance;
  }

  start(task: AgentTask): Result<void> {
    if (this.projects.has(task.projectId)) {
      return {
        ok: false,
        error: "This project already has an active task",
        code: ErrorCode.TASK_ALREADY_RUNNING,
      };
    }

    const executor = this.createExecutor(task);
    this.projects.set(task.projectId, { taskId: task.id, executor });
    void executor.run(task).catch((error: unknown) => {
      console.error(`Agent executor failed for task ${task.id}:`, error);
    }).finally(() => {
      const active = this.projects.get(task.projectId);
      if (active?.taskId === task.id) this.projects.delete(task.projectId);
    });
    return { ok: true, data: undefined };
  }

  async cancel(taskId: string): Promise<Result<void>> {
    for (const active of this.projects.values()) {
      if (active.taskId === taskId) {
        active.executor.stop();
        return { ok: true, data: undefined };
      }
    }
    return { ok: false, error: `Task ${taskId} is not active`, code: ErrorCode.TASK_NOT_FOUND };
  }
}
