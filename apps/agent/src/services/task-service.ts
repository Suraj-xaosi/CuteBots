import { ErrorCode, ProjectStatus, SandboxStatus, TaskStatus, type Result } from "@workspace/types";
import type { PrismaClient } from "@workspace/db";
import type { AgentLoopManager } from "@workspace/core";
import { ApiError } from "../http/api-error.js";
import type { HumanReplyInbox } from "@workspace/core";
import type { AgentTask } from "@workspace/core/agent/agent-types";

export interface TaskListItem {
  id: string;
  project_id: string;
  description: string;
  status: TaskStatus;
  fail_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export class TaskService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly loops: AgentLoopManager,
    private readonly replies: HumanReplyInbox,
  ) {}

  async list(projectId: string, limit = 50, cursor?: string): Promise<TaskListItem[]> {
    await this.requireProject(projectId);
    const rows = await this.prisma.task.findMany({
      where: { project_id: projectId },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(Math.floor(limit), 1), 100),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        project_id: true,
        description: true,
        status: true,
        fail_reason: true,
        created_at: true,
        updated_at: true,
      },
    });
    return rows.map((task) => ({ ...task, status: toTaskStatus(task.status) }));
  }

  async create(projectId: string, description: string): Promise<{ task: unknown; queued: boolean; position: number }> {
    const project = await this.requireProject(projectId);
    if (project.status !== ProjectStatus.ACTIVE) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Project is stopped");
    }
    if (project.sandbox_status !== SandboxStatus.RUNNING) {
      throw new ApiError(503, ErrorCode.CONTAINER_NOT_FOUND, "Project sandbox is stopped");
    }

    const task = await this.prisma.task.create({
      data: { project_id: projectId, description: description.trim(), status: TaskStatus.PENDING },
      select: { id: true, project_id: true, description: true, status: true, created_at: true },
    });
    const queued = this.loops.enqueue({ id: task.id, projectId, description: task.description });
    if (!queued.ok) {
      await this.prisma.task.delete({ where: { id: task.id } });
      throw new ApiError(409, queued.code, queued.error);
    }
    return { task, ...queued.data };
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task not found");
    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING) {
      throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task is not running or queued");
    }
    const cancelled = await this.loops.cancel(taskId);
    if (!cancelled.ok && cancelled.code !== ErrorCode.TASK_NOT_FOUND) {
      throw new ApiError(404, cancelled.code, cancelled.error);
    }
    if (!cancelled.ok) {
      const marked = await this.prisma.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.CANCELLED, fail_reason: "Cancelled after agent process recovery" },
      });
      void marked;
    }
  }

  async resume(taskId: string): Promise<Result<{ queued: boolean; position: number }>> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task not found");
    if (task.status !== TaskStatus.PAUSED) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Only paused tasks can be resumed");
    }
    const project = await this.requireProject(task.project_id);
    if (project.status !== ProjectStatus.ACTIVE || project.sandbox_status !== SandboxStatus.RUNNING) {
      throw new ApiError(503, ErrorCode.CONTAINER_NOT_FOUND, "Project and sandbox must be running to resume");
    }
    const enqueued = this.loops.enqueue({
      id: task.id,
      projectId: task.project_id,
      description: task.description,
      resume: true,
    });
    if (!enqueued.ok) throw new ApiError(409, enqueued.code, enqueued.error);
    return enqueued;
  }

  async getUsage(taskId: string): Promise<{
    taskId: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    latest_recorded_at: string | null;
  }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        token_usage: {
          select: {
            input_tokens: true,
            output_tokens: true,
            created_at: true,
          },
          orderBy: { created_at: "desc" },
        },
      },
    });

    if (!task) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task not found");

    const inputTokens = task.token_usage.reduce((sum, entry) => sum + Number(entry.input_tokens ?? 0), 0);
    const outputTokens = task.token_usage.reduce((sum, entry) => sum + Number(entry.output_tokens ?? 0), 0);
    const latestRecordedAt = task.token_usage[0]?.created_at ? new Date(task.token_usage[0].created_at).toISOString() : null;

    return {
      taskId: task.id,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      latest_recorded_at: latestRecordedAt,
    };
  }

  async reply(taskId: string, reply: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
    if (!task || task.status !== TaskStatus.RUNNING) {
      throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task is not running");
    }
    const submitted = this.replies.submit(taskId, reply);
    if (!submitted.ok) {
      throw new ApiError(submitted.code === ErrorCode.TASK_NOT_FOUND ? 404 : 409, submitted.code, submitted.error);
    }
  }

  async cancelProjectTasks(projectId: string): Promise<void> {
    const tasks = await this.prisma.task.findMany({
      where: { project_id: projectId, status: { in: [TaskStatus.RUNNING, TaskStatus.PENDING] } },
      select: { id: true },
    });
    for (const task of tasks) await this.cancel(task.id);
  }

  private async requireProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    return project;
  }
}

function toTaskStatus(status: string): TaskStatus {
  switch (status) {
    case "PENDING": return TaskStatus.PENDING;
    case "RUNNING": return TaskStatus.RUNNING;
    case "PAUSED": return TaskStatus.PAUSED;
    case "DONE": return TaskStatus.DONE;
    case "FAILED": return TaskStatus.FAILED;
    case "CANCELLED": return TaskStatus.CANCELLED;
    default: throw new Error(`Unknown task status: ${status}`);
  }
}