import { ErrorCode, ProjectStatus, SandboxStatus, TaskStatus, type Result } from "@workspace/types";
import { ContainerManager } from "@workspace/core";
import { PrismaClient, SecretVault } from "@workspace/db";
import { ApiError } from "../http/api-error.js";

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  github_token?: string;
  clone_credential?: string;
  sandbox_type?: string;
}

export interface PublicProject {
  id: string;
  name: string;
  repo_url: string;
  container_id: string | null;
  status: ProjectStatus;
  sandbox_status: SandboxStatus;
  sandbox_type: string;
  workspace_ready: boolean;
  created_at: Date;
}

export interface AgentProjectData {
  id: string;
  name: string;
  repo_url: string;
  github_token: string | null;
  clone_credential: string | null;
  container_id: string | null;
  status: ProjectStatus;
  sandbox_status: SandboxStatus;
  sandbox_type: string;
  workspace_ready: boolean;
}

export class ProjectService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly containers: ContainerManager,
    private readonly vaultFactory: () => SecretVault = () => new SecretVault(),
  ) {}

  async list(): Promise<PublicProject[]> {
    const projects = await this.prisma.project.findMany({ orderBy: { created_at: "desc" } });
    return projects.map(toPublicProject);
  }

  async get(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    return toPublicProject(project);
  }

  async getForAgent(projectId: string): Promise<AgentProjectData> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    return {
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      github_token: project.github_token,
      clone_credential: project.clone_credential,
      container_id: project.container_id,
      status: toProjectStatus(project.status),
      sandbox_status: toSandboxStatus(project.sandbox_status),
      sandbox_type: project.sandbox_type,
      workspace_ready: project.workspace_ready,
    };
  }

  async create(input: CreateProjectInput): Promise<PublicProject> {
    if (!isGitHubRepositoryUrl(input.repo_url)) {
      throw new ApiError(400, ErrorCode.GITHUB_API_FAILED, "Repository URL must be a clean HTTPS GitHub URL");
    }

    let encryptedWriteToken: string | null = null;
    let encryptedCloneCredential: string | null = null;
    if (input.github_token || input.clone_credential) {
      let vault: SecretVault;
      try {
        vault = this.vaultFactory();
      } catch (error) {
        throw new ApiError(
          500,
          ErrorCode.INVALID_API_KEY,
          error instanceof Error ? error.message : "Secret encryption is not configured",
        );
      }
      encryptedWriteToken = input.github_token ? vault.encrypt(input.github_token) : null;
      encryptedCloneCredential = input.clone_credential ? vault.encrypt(input.clone_credential) : null;
    }

    const project = await this.prisma.project.create({
      data: {
        name: input.name.trim(),
        repo_url: input.repo_url,
        github_token: encryptedWriteToken,
        clone_credential: encryptedCloneCredential,
        sandbox_type: input.sandbox_type ?? "node",
        status: ProjectStatus.ACTIVE,
        sandbox_status: SandboxStatus.STOPPED,
      },
    });

    const created = await this.containers.create(project.id);
    if (!created.ok) {
      await this.prisma.project.delete({ where: { id: project.id } });
      throw new ApiError(503, created.code, created.error);
    }

    try {
      const updated = await this.prisma.project.update({
        where: { id: project.id },
        data: { container_id: created.data.getId(), sandbox_status: SandboxStatus.RUNNING },
      });
      return toPublicProject(updated);
    } catch (error) {
      await this.containers.destroy(project.id);
      await this.prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
      throw error;
    }
  }

  async destroy(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");

    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  async recoverOnStartup(): Promise<Array<{ id: string; projectId: string; description: string }>> {
    const activeProjects = await this.prisma.project.findMany({
      where: {
        status: ProjectStatus.ACTIVE,
        sandbox_status: SandboxStatus.RUNNING,
      },
      select: {
        id: true,
        container_id: true,
        sandbox_status: true,
        workspace_ready: true,
      },
    });

    const pendingTasks = await this.prisma.task.findMany({
      where: { status: TaskStatus.PENDING },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: { id: true, project_id: true, description: true },
    });

    await this.prisma.task.updateMany({
      where: { status: TaskStatus.RUNNING },
      data: {
        status: TaskStatus.FAILED,
        fail_reason: "Server crashed",
      },
    });

    const recoveredProjectIds = new Set<string>();
    for (const project of activeProjects) {
      const recovered = await this.containers.recover(project.id);
      if (!recovered.ok) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: {
            container_id: null,
            sandbox_status: SandboxStatus.STOPPED,
            workspace_ready: false,
          },
        });
        continue;
      }

      const attached = this.containers.get(project.id);
      const containerId = attached.ok ? attached.data.getId() : project.container_id;
      recoveredProjectIds.add(project.id);

      await this.prisma.project.update({
        where: { id: project.id },
        data: {
          container_id: containerId ?? null,
          sandbox_status: SandboxStatus.RUNNING,
          workspace_ready: project.workspace_ready,
        },
      });
    }

    const resumableTasks = pendingTasks
      .filter((task) => recoveredProjectIds.has(task.project_id))
      .map((task) => ({ id: task.id, projectId: task.project_id, description: task.description }));
    const strandedTasks = pendingTasks.filter((task) => !recoveredProjectIds.has(task.project_id));
    if (strandedTasks.length) {
      await this.prisma.task.updateMany({
        where: { id: { in: strandedTasks.map((task) => task.id) } },
        data: { status: TaskStatus.FAILED, fail_reason: "Project sandbox unavailable during recovery" },
      });
    }

    await this.containers.cleanupStale(recoveredProjectIds);
    return resumableTasks;
  }

  async startSandbox(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    if (project.sandbox_status === SandboxStatus.RUNNING) return toPublicProject(project);

    const recovered = await this.containers.recover(projectId);
    const sandbox = recovered.ok
      ? this.containers.get(projectId)
      : await this.containers.create(projectId);
    if (!sandbox.ok) throw new ApiError(503, sandbox.code, sandbox.error);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { container_id: sandbox.data.getId(), sandbox_status: SandboxStatus.RUNNING },
    });
    return toPublicProject(updated);
  }

  async destroySandbox(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: null,
        sandbox_status: SandboxStatus.STOPPED,
        workspace_ready: false,
      },
    });
    return toPublicProject(updated);
  }

  async getSandbox(projectId: string): Promise<Result<ReturnType<ContainerManager["get"]> extends Result<infer T> ? T : never>> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return { ok: false, error: "Project not found", code: ErrorCode.TASK_NOT_FOUND };
    if (project.sandbox_status !== SandboxStatus.RUNNING) {
      return { ok: false, error: "Sandbox is stopped", code: ErrorCode.CONTAINER_NOT_FOUND };
    }
    let sandbox = this.containers.get(projectId);
    if (!sandbox.ok) {
      const recovered = await this.containers.recover(projectId);
      if (!recovered.ok) return recovered;
      sandbox = this.containers.get(projectId);
    }
    return sandbox;
  }
}

function toPublicProject(project: {
  id: string;
  name: string;
  repo_url: string;
  container_id: string | null;
  status: string;
  sandbox_status: string;
  sandbox_type: string;
  workspace_ready: boolean;
  created_at: Date;
}): PublicProject {
  return {
    id: project.id,
    name: project.name,
    repo_url: project.repo_url,
    container_id: project.container_id,
    status: toProjectStatus(project.status),
    sandbox_status: toSandboxStatus(project.sandbox_status),
    sandbox_type: project.sandbox_type,
    workspace_ready: project.workspace_ready,
    created_at: project.created_at,
  };
}

function isGitHubRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.split("/").filter(Boolean).length === 2;
  } catch {
    return false;
  }
}

function toProjectStatus(status: string): ProjectStatus {
  if (status === ProjectStatus.ACTIVE) return ProjectStatus.ACTIVE;
  if (status === ProjectStatus.STOPPED) return ProjectStatus.STOPPED;
  throw new Error(`Unknown project status: ${status}`);
}

function toSandboxStatus(status: string): SandboxStatus {
  if (status === SandboxStatus.RUNNING) return SandboxStatus.RUNNING;
  if (status === SandboxStatus.STOPPED) return SandboxStatus.STOPPED;
  throw new Error(`Unknown sandbox status: ${status}`);
}