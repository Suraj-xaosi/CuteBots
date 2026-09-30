import { ErrorCode, TaskStatus, type Result } from "@workspace/types";
import type { AgentPersistence, AgentQueueReceipt, AgentTask, AgentExecutor } from "./agent-types.js";

export type AgentExecutorFactory = (task: AgentTask) => AgentExecutor;

interface ProjectQueue {
  activeTaskId?: string;
  activeExecutor?: AgentExecutor;
  pending: AgentTask[];
}

export class AgentLoopManager {
  private static instance: AgentLoopManager | undefined;
  private readonly projects = new Map<string, ProjectQueue>();

  private constructor(
    private readonly createExecutor: AgentExecutorFactory,
    private readonly persistence: AgentPersistence,
  ) {}

  static getInstance(
    createExecutor?: AgentExecutorFactory,
    persistence?: AgentPersistence,
  ): AgentLoopManager {
    if (!this.instance) {
      if (!createExecutor || !persistence) {
        throw new Error("AgentLoopManager must be initialized with an executor factory and persistence");
      }
      this.instance = new AgentLoopManager(createExecutor, persistence);
    }
    return this.instance;
  }

  enqueue(task: AgentTask): Result<AgentQueueReceipt> {
    const project = this.projects.get(task.projectId) ?? { pending: [] };
    if (project.activeTaskId === task.id || project.pending.some((queued) => queued.id === task.id)) {
      return {
        ok: false,
        error: `Task ${task.id} is already active or queued`,
        code: ErrorCode.TASK_ALREADY_RUNNING,
      };
    }

    project.pending.push(task);
    this.projects.set(task.projectId, project);
    const queued = Boolean(project.activeTaskId);
    const position = queued ? project.pending.length : 0;
    this.startNext(task.projectId, project);
    return { ok: true, data: { queued, position } };
  }

  async cancel(taskId: string): Promise<Result<void>> {
    for (const [projectId, project] of this.projects) {
      if (project.activeTaskId === taskId) {
        project.activeExecutor?.stop();
        return { ok: true, data: undefined };
      }

      const queuedIndex = project.pending.findIndex((task) => task.id === taskId);
      if (queuedIndex >= 0) {
        const [task] = project.pending.splice(queuedIndex, 1);
        const updated = await this.persistence.updateTaskStatus(taskId, TaskStatus.CANCELLED, "Cancelled while queued");
        if (!updated.ok) {
          if (task) project.pending.splice(queuedIndex, 0, task);
          return updated;
        }
        if (!project.activeTaskId && project.pending.length === 0) this.projects.delete(projectId);
        return { ok: true, data: undefined };
      }
    }

    return { ok: false, error: `Task ${taskId} is not active or queued`, code: ErrorCode.TASK_NOT_FOUND };
  }

  private startNext(projectId: string, project: ProjectQueue): void {
    if (project.activeTaskId) return;
    const task = project.pending.shift();
    if (!task) {
      this.projects.delete(projectId);
      return;
    }

    const executor = this.createExecutor(task);
    project.activeTaskId = task.id;
    project.activeExecutor = executor;
    void executor.run(task).catch(() => undefined).finally(() => {
      if (project.activeTaskId !== task.id) return;
      project.activeTaskId = undefined;
      project.activeExecutor = undefined;
      this.startNext(projectId, project);
    });
  }
}