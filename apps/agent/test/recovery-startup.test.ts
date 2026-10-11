import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode, ProjectStatus, SandboxStatus, TaskStatus } from "@workspace/types";
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
    create: async () => ({ ok: false, error: "Container not found", code: ErrorCode.CONTAINER_NOT_FOUND }),
    cleanupStale: async (projectIds: ReadonlySet<string>) => {
      assert.deepEqual([...projectIds], ["proj-ok", "proj-lost"]);
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
  assert.equal(projectTable.get("proj-lost")?.container_id, "cid-lost");
});

test("recoverOnStartup recreates a deleted container with its saved profile and reprovisions it", async () => {
  const project = {
    id: "proj-deleted",
    name: "deleted",
    repo_url: "https://github.com/acme/deleted",
    github_token: null,
    clone_credential: null,
    container_id: "cid-old",
    status: ProjectStatus.ACTIVE,
    sandbox_status: SandboxStatus.RUNNING,
    sandbox_type: "minimal",
    workspace_ready: true,
    setup_status: "READY",
  };
  const projectTable = new Map([[project.id, { ...project }]]);
  const prisma = {
    task: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    project: {
      findMany: async () => Array.from(projectTable.values()),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = projectTable.get(where.id);
        assert.ok(current);
        Object.assign(current, data);
        return { ...current };
      },
    },
  } as any;

  const createdProfiles: string[] = [];
  const containers = {
    recover: async () => ({
      ok: false,
      error: "Container not found",
      code: ErrorCode.CONTAINER_NOT_FOUND,
    }),
    create: async (_projectId: string, profile: string) => {
      createdProfiles.push(profile);
      return { ok: true, data: { getId: () => "cid-new" } };
    },
    get: () => ({ ok: true, data: { getId: () => "cid-new" } }),
    cleanupStale: async () => ({ ok: true, data: undefined }),
  } as any;

  const service = new ProjectService(prisma, containers);
  (service as any).startProvisioning = () => undefined;
  await service.recoverOnStartup();

  assert.deepEqual(createdProfiles, ["minimal"]);
  assert.equal(projectTable.get(project.id)?.container_id, "cid-new");
  assert.equal(projectTable.get(project.id)?.sandbox_status, SandboxStatus.RUNNING);
  assert.equal(projectTable.get(project.id)?.workspace_ready, false);
  assert.equal(projectTable.get(project.id)?.setup_status, "PROVISIONING");
});

test("switchToNodeSandbox replaces only a failed No-Node mismatch with a fresh Node container", async () => {
  const project = {
    id: "proj-node-switch",
    name: "switch",
    repo_url: "https://github.com/acme/switch",
    github_token: null,
    clone_credential: null,
    container_id: "cid-minimal",
    status: ProjectStatus.ACTIVE,
    sandbox_status: SandboxStatus.RUNNING,
    sandbox_type: "minimal",
    workspace_ready: false,
    setup_status: "FAILED",
    setup_error: "This repository needs Node.js, but the selected No Node.js sandbox does not include it.",
    setup_log: "Previous setup failed.\n",
    setup_attempts: 1,
    detected_setup: null,
  };
  const projectTable = new Map([[project.id, { ...project }]]);
  const prisma = {
    project: {
      findUnique: async () => ({ ...projectTable.get(project.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = projectTable.get(where.id);
        assert.ok(current);
        Object.assign(current, data);
        return { ...current };
      },
    },
  } as any;
  const destroyed: string[] = [];
  const profiles: string[] = [];
  const containers = {
    destroy: async (projectId: string) => {
      destroyed.push(projectId);
      return { ok: true, data: undefined };
    },
    create: async (_projectId: string, profile: string) => {
      profiles.push(profile);
      return { ok: true, data: { getId: () => "cid-node" } };
    },
  } as any;
  const service = new ProjectService(prisma, containers);
  (service as any).startProvisioning = () => undefined;

  const updated = await service.switchToNodeSandbox(project.id);

  assert.deepEqual(destroyed, [project.id]);
  assert.deepEqual(profiles, ["node"]);
  assert.equal(updated.sandbox_type, "node");
  assert.equal(updated.container_id, "cid-node");
  assert.equal(updated.sandbox_status, SandboxStatus.RUNNING);
  assert.equal(updated.setup_status, "PROVISIONING");
  assert.equal(updated.workspace_ready, false);
});

test("startSandbox reuses a stopped existing container without resetting a ready workspace", async () => {
  const project = {
    id: "proj-stopped",
    name: "stopped",
    repo_url: "https://github.com/acme/stopped",
    github_token: null,
    clone_credential: null,
    container_id: "cid-existing",
    status: ProjectStatus.ACTIVE,
    sandbox_status: SandboxStatus.STOPPED,
    sandbox_type: "node",
    workspace_ready: true,
    setup_status: "READY",
    setup_log: "Setup complete.\n",
    setup_error: null,
    setup_attempts: 1,
    detected_setup: "Node.js",
    created_at: new Date(),
  };
  const projectTable = new Map([[project.id, { ...project }]]);
  const prisma = {
    project: {
      findUnique: async () => ({ ...projectTable.get(project.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = projectTable.get(where.id);
        assert.ok(current);
        Object.assign(current, data);
        return { ...current };
      },
    },
  } as any;
  const profiles: string[] = [];
  const containers = {
    recover: async (_projectId: string, profile: string) => {
      profiles.push(profile);
      return { ok: true, data: undefined };
    },
    get: () => ({ ok: true, data: { getId: () => "cid-existing" } }),
    create: async () => {
      assert.fail("A stopped existing container must not be replaced");
    },
  } as any;

  const updated = await new ProjectService(prisma, containers).startSandbox(project.id);

  assert.deepEqual(profiles, ["node"]);
  assert.equal(updated.container_id, "cid-existing");
  assert.equal(updated.sandbox_status, SandboxStatus.RUNNING);
  assert.equal(updated.setup_status, "READY");
  assert.equal(updated.workspace_ready, true);
});
