import assert from "node:assert/strict";
import test from "node:test";

import { ProjectStatus, SandboxStatus, TaskStatus } from "@workspace/types";
import { ProjectService } from "../src/services/project-service.js";

test("recoverOnStartup marks crashed tasks as failed and reattaches surviving sandboxes", async () => {
  const projects = [
    {
      id: "proj-ok",
      name: "healthy",
      repo_url: "https://github.com/acme/healthy",
      github_token: null,
      clone_credential: null,
      container_id: "cid-healthy",
      status: ProjectStatus.ACTIVE,
      sandbox_status: SandboxStatus.RUNNING,
      sandbox_type: "node",
      workspace_ready: true,
    },
    {
      id: "proj-lost",
      name: "lost",
      repo_url: "https://github.com/acme/lost",
      github_token: null,
      clone_credential: null,
      container_id: "cid-lost",
      status: ProjectStatus.ACTIVE,
      sandbox_status: SandboxStatus.RUNNING,
      sandbox_type: "node",
      workspace_ready: true,
    },
  ];

  const tasks = [
    { id: "task-running", project_id: "proj-ok", status: TaskStatus.RUNNING, fail_reason: null },
    { id: "task-pending", project_id: "proj-ok", description: "continue queued work", status: TaskStatus.PENDING, fail_reason: null },
    { id: "task-stranded", project_id: "proj-lost", description: "cannot run", status: TaskStatus.PENDING, fail_reason: null },
    { id: "task-paused", project_id: "proj-ok", status: TaskStatus.PAUSED, fail_reason: null },
    { id: "task-other", project_id: "proj-lost", status: TaskStatus.RUNNING, fail_reason: null },
  ];

  const projectTable = new Map(projects.map((project) => [project.id, { ...project }]));
  const taskTable = new Map(tasks.map((task) => [task.id, { ...task }]));

  const prisma = {
    task: {
      findMany: async ({ where, orderBy }: { where: { status: TaskStatus }; orderBy: unknown }) => {
        assert.deepEqual(orderBy, [{ created_at: "asc" }, { id: "asc" }]);
        return Array.from(taskTable.values())
          .filter((task) => task.status === where.status)
          .map(({ id, project_id, description }) => ({ id, project_id, description }));
      },
      updateMany: async ({ where, data }: { where: { status?: TaskStatus; id?: { in: string[] } }; data: { status: TaskStatus; fail_reason: string } }) => {
        let count = 0;
        for (const task of taskTable.values()) {
          if ((where.status === undefined || task.status === where.status) && (!where.id || where.id.in.includes(task.id))) {
            task.status = data.status;
            task.fail_reason = data.fail_reason;
            count += 1;
          }
        }
        return { count };
      },
    },
    project: {
      findMany: async () => Array.from(projectTable.values()),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const project = projectTable.get(where.id);
        assert.ok(project);
        Object.assign(project, data);
        return { ...project };
      },
    },
  } as any;

  const containers = {
    recover: async (projectId: string) => {
      if (projectId === "proj-ok") {
        return { ok: true, data: undefined };
      }
      return { ok: false, error: "Container not found", code: "CONTAINER_NOT_FOUND" };
    },
    get: (projectId: string) => {
      if (projectId === "proj-ok") {
        return { ok: true, data: { getId: () => "cid-healthy" } };
      }
      return { ok: false, error: "Container not found", code: "CONTAINER_NOT_FOUND" };
    },
    cleanupStale: async (projectIds: ReadonlySet<string>) => {
      assert.deepEqual([...projectIds], ["proj-ok"]);
      return { ok: true, data: undefined };
    },
  } as any;

  const service = new ProjectService(prisma, containers);
  const pendingTasks = await service.recoverOnStartup();

  assert.equal(taskTable.get("task-running")?.status, TaskStatus.FAILED);
  assert.equal(taskTable.get("task-running")?.fail_reason, "Server crashed");
  assert.equal(taskTable.get("task-paused")?.status, TaskStatus.PAUSED);
  assert.deepEqual(pendingTasks, [{ id: "task-pending", projectId: "proj-ok", description: "continue queued work" }]);
  assert.equal(taskTable.get("task-stranded")?.status, TaskStatus.FAILED);
  assert.equal(taskTable.get("task-stranded")?.fail_reason, "Project sandbox unavailable during recovery");
  assert.equal(projectTable.get("proj-ok")?.sandbox_status, SandboxStatus.RUNNING);
  assert.equal(projectTable.get("proj-lost")?.sandbox_status, SandboxStatus.STOPPED);
  assert.equal(projectTable.get("proj-lost")?.container_id, null);
});
