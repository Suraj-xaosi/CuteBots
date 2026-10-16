import { ErrorCode, SandboxStatus, TaskStatus } from "@workspace/types";
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
  completion_summary: string | null;
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
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
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
        completion_summary: true,
        fail_reason: true,
        created_at: true,
        updated_at: true,
      },
    });
    return rows.map((task) => ({ ...task, status: toTaskStatus(task.status) }));
  }

  async create(projectId: string, description: string): Promise<{ task: TaskListItem }> {
    const project = await this.requireReadyProject(projectId);
    if (project.active_task_id) {
      throw new ApiError(409, ErrorCode.TASK_ALREADY_RUNNING, "This project already has an active task");
    }

    const task = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.task.create({
        data: { project_id: projectId, description: description.trim(), status: TaskStatus.RUNNING },
      });
      const claimed = await transaction.project.updateMany({
        where: { id: projectId, active_task_id: null },
        data: { active_task_id: created.id },
      });
      if (claimed.count !== 1) {
        throw new ApiError(409, ErrorCode.TASK_ALREADY_RUNNING, "This project already has an active task");
      }
      return created;
    });

    const started = this.loops.start({
      id: task.id,
      projectId,
      description: task.description,
      branchName: project.branch_name ?? undefined,
      projectContext: project.context,
    });
    if (!started.ok) {
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.FAILED, fail_reason: started.error },
      });
      await this.prisma.project.updateMany({
        where: { id: projectId, active_task_id: task.id },
        data: { active_task_id: null },
      });
      throw new ApiError(409, started.code, started.error);
    }

    return { task: { ...task, status: TaskStatus.RUNNING, completion_summary: null } };
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task not found");
    if (task.status !== TaskStatus.RUNNING) {
      throw new ApiError(409, ErrorCode.TASK_NOT_FOUND, "Task is not running");
    }
    const cancelled = await this.loops.cancel(taskId);
    if (!cancelled.ok && cancelled.code !== ErrorCode.TASK_NOT_FOUND) {
      throw new ApiError(409, cancelled.code, cancelled.error);
    }
    if (!cancelled.ok) {
      const interrupted = await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.INTERRUPTED,
          fail_reason: "Task interrupted after agent process recovery",
        },
      });
      await this.prisma.project.updateMany({
        where: { id: interrupted.project_id, active_task_id: taskId },
        data: { active_task_id: null },
      });
    }
  }

  async resume(taskId: string, continuation: string): Promise<{ status: "RUNNING" }> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Task not found");
    if (task.status !== TaskStatus.INTERRUPTED) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Only interrupted tasks can be continued");
    }
    const project = await this.requireReadyProject(task.project_id);

    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.project.updateMany({
        where: { id: project.id, active_task_id: null },
        data: { active_task_id: task.id },
      });
      if (claimed.count !== 1) {
        throw new ApiError(409, ErrorCode.TASK_ALREADY_RUNNING, "This project already has an active task");
      }
      await transaction.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.RUNNING, fail_reason: null },
      });
    });

    const started = this.loops.start({
      id: task.id,
      projectId: task.project_id,
      description: task.description,
      continuation: continuation.trim(),
      resume: true,
      branchName: project.branch_name ?? undefined,
      projectContext: project.context,
    });
    if (!started.ok) {
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.INTERRUPTED, fail_reason: started.error },
      });
      await this.prisma.project.updateMany({
        where: { id: project.id, active_task_id: task.id },
        data: { active_task_id: null },
      });
      throw new ApiError(409, started.code, started.error);
    }
    return { status: "RUNNING" };
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

  private async requireReadyProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    if (project.sandbox_status !== SandboxStatus.RUNNING) {
      throw new ApiError(503, ErrorCode.CONTAINER_NOT_FOUND, "Project sandbox is stopped");
    }
    if (project.provision_status !== "READY") {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, project.provision_error ?? "Repository provisioning is not ready");
    }
    return project;
  }
}

function toTaskStatus(status: string): TaskStatus {
  switch (status) {
    case "RUNNING": return TaskStatus.RUNNING;
    case "INTERRUPTED": return TaskStatus.INTERRUPTED;
    case "AWAITING_APPROVAL": return TaskStatus.DONE;
    case "DONE": return TaskStatus.DONE;
    case "FAILED": return TaskStatus.FAILED;
    default:
      throw new Error(`Unknown task status: ${status}`);
  }
}
