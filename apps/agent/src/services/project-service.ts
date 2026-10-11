import { ErrorCode, ProjectStatus, SandboxStatus, TaskStatus, type Result } from "@workspace/types";
import { ContainerManager } from "@workspace/core";
import { PrismaClient, SecretVault } from "@workspace/db";
import { ApiError } from "../http/api-error.js";
import { ProjectSetupError, ProjectSetupService } from "./project-setup.js";
import { redactTextSecrets } from "@workspace/core";

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  github_token?: string;
  clone_credential?: string;
  sandbox_type?: "node" | "minimal";
}

export type ProjectSetupStatus = "PENDING" | "PROVISIONING" | "READY" | "FAILED";

export interface PublicProject {
  id: string;
  name: string;
  repo_url: string;
  container_id: string | null;
  status: ProjectStatus;
  sandbox_status: SandboxStatus;
  sandbox_type: string;
  workspace_ready: boolean;
  setup_status: ProjectSetupStatus;
  setup_log: string;
  setup_error: string | null;
  setup_attempts: number;
  detected_setup: string | null;
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
  setup_status: ProjectSetupStatus;
  detected_setup: string | null;
}

export class ProjectService {
  private readonly setups = new Map<string, Promise<void>>();
  private readonly setupVersions = new Map<string, number>();
  private readonly setupRunner: ProjectSetupService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly containers: ContainerManager,
    private readonly vaultFactory: () => SecretVault = () => new SecretVault(),
  ) {
    this.setupRunner = new ProjectSetupService(prisma, containers, vaultFactory);
  }

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
      setup_status: toSetupStatus(project.setup_status),
      detected_setup: project.detected_setup,
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

    const created = await this.containers.create(project.id, toSandboxProfile(project.sandbox_type));
    if (!created.ok) {
      await this.prisma.project.delete({ where: { id: project.id } });
      throw new ApiError(503, created.code, created.error);
    }

    try {
      const updated = await this.prisma.project.update({
        where: { id: project.id },
        data: {
          container_id: created.data.getId(),
          sandbox_status: SandboxStatus.RUNNING,
          setup_status: "PROVISIONING",
        },
      });
      this.startProvisioning(project.id);
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

    this.invalidateSetup(projectId);
    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  async recoverOnStartup(): Promise<Array<{ id: string; projectId: string; description: string }>> {
    const activeProjects = await this.prisma.project.findMany({
      where: {
        status: ProjectStatus.ACTIVE,
        OR: [
          { sandbox_status: SandboxStatus.RUNNING },
          { sandbox_status: SandboxStatus.STOPPED, container_id: { not: null } },
        ],
      },
      select: {
        id: true,
        container_id: true,
        sandbox_status: true,
        workspace_ready: true,
        sandbox_type: true,
        setup_status: true,
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
    const readyProjectIds = new Set<string>();
    const waitingProjectIds = new Set<string>();
    for (const project of activeProjects) {
      recoveredProjectIds.add(project.id);
      const profile = project.sandbox_type === "minimal" ? "minimal" : "node";
      let recovered = await this.containers.recover(project.id, profile);
      let setupStatus = toSetupStatus(project.setup_status ?? (project.workspace_ready ? "READY" : "PENDING"));
      let workspaceReady = project.workspace_ready;
      if (!recovered.ok && recovered.code === ErrorCode.CONTAINER_NOT_FOUND) {
        const created = await this.containers.create(project.id, profile);
        if (created.ok) {
          recovered = { ok: true, data: undefined };
          setupStatus = "PENDING";
          workspaceReady = false;
        } else {
          recovered = created;
        }
      }
      if (!recovered.ok) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: {
            sandbox_status: SandboxStatus.STOPPED,
          },
        });
        continue;
      }

      const attached = this.containers.get(project.id);
      const containerId = attached.ok ? attached.data.getId() : project.container_id;
      if (setupStatus === "READY" && workspaceReady) readyProjectIds.add(project.id);
      else if (setupStatus !== "FAILED") {
        waitingProjectIds.add(project.id);
      }

      await this.prisma.project.update({
        where: { id: project.id },
        data: {
          container_id: containerId ?? null,
          sandbox_status: SandboxStatus.RUNNING,
          workspace_ready: workspaceReady,
          ...(workspaceReady ? {} : { setup_status: setupStatus === "FAILED" ? "FAILED" : "PROVISIONING" }),
        },
      });
      if (waitingProjectIds.has(project.id)) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: {
            setup_status: "PROVISIONING",
            setup_error: null,
            workspace_ready: false,
          },
        });
        this.startProvisioning(project.id);
      }
    }

    const resumableTasks = pendingTasks
      .filter((task) => readyProjectIds.has(task.project_id))
      .map((task) => ({ id: task.id, projectId: task.project_id, description: task.description }));
    const strandedTasks = pendingTasks.filter((task) => !readyProjectIds.has(task.project_id) && !waitingProjectIds.has(task.project_id));
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

    const profile = toSandboxProfile(project.sandbox_type);
    const recovered = await this.containers.recover(projectId, profile);
    const missingContainer = !recovered.ok && recovered.code === ErrorCode.CONTAINER_NOT_FOUND;
    if (!recovered.ok && !missingContainer) {
      throw new ApiError(503, recovered.code, recovered.error);
    }
    const sandbox = recovered.ok
      ? this.containers.get(projectId)
      : await this.containers.create(projectId, profile);
    if (!sandbox.ok) throw new ApiError(503, sandbox.code, sandbox.error);

    const data = missingContainer
      ? {
          container_id: sandbox.data.getId(),
          sandbox_status: SandboxStatus.RUNNING,
          workspace_ready: false,
          setup_status: "PROVISIONING",
          setup_error: null,
          setup_log: "A missing sandbox was recreated. Preparing repository and dependencies.\n",
          setup_attempts: 0,
          detected_setup: null,
        }
      : { container_id: sandbox.data.getId(), sandbox_status: SandboxStatus.RUNNING };
    const updated = await this.prisma.project.update({ where: { id: projectId }, data });
    if (missingContainer) this.startProvisioning(projectId);
    return toPublicProject(updated);
  }

  async destroySandbox(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    if (this.setups.has(projectId)) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Wait for project setup to finish before stopping its sandbox");
    }
    this.invalidateSetup(projectId);
    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: null,
        sandbox_status: SandboxStatus.STOPPED,
        workspace_ready: false,
        setup_status: "PENDING",
        setup_error: null,
        setup_log: "",
        setup_attempts: 0,
        detected_setup: null,
      },
    });
    return toPublicProject(updated);
  }

  async retrySetup(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    if (project.setup_status !== "FAILED") {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Only failed project setup can be retried");
    }
    if (project.sandbox_status !== SandboxStatus.RUNNING) {
      throw new ApiError(409, ErrorCode.CONTAINER_NOT_FOUND, "Start the project sandbox before retrying setup");
    }
    if (this.setups.has(projectId)) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Project setup is already running");
    }
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        setup_status: "PROVISIONING",
        setup_error: null,
        workspace_ready: false,
        setup_attempts: project.setup_attempts,
        setup_log: `${project.setup_log}\nManual setup retry requested.\n`.slice(-80_000),
      },
    });
    this.startProvisioning(projectId);
    return toPublicProject(updated);
  }

  async switchToNodeSandbox(projectId: string): Promise<PublicProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    if (
      project.setup_status !== "FAILED" ||
      project.sandbox_type !== "minimal" ||
      !project.setup_error?.includes("needs Node.js")
    ) {
      throw new ApiError(
        409,
        ErrorCode.TOOL_EXECUTION_FAILED,
        "Switching to the Node.js sandbox is available only when setup failed because this No Node.js project needs Node.js.",
      );
    }
    if (this.setups.has(projectId)) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Project setup is already running");
    }

    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);
    this.invalidateSetup(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: null,
        sandbox_type: "node",
        sandbox_status: SandboxStatus.STOPPED,
        workspace_ready: false,
        setup_status: "PENDING",
        setup_error: null,
        setup_log: `${project.setup_log}\nSwitching to a fresh Node.js sandbox.\n`.slice(-80_000),
        setup_attempts: 0,
        detected_setup: null,
      },
    });

    const created = await this.containers.create(projectId, "node");
    if (!created.ok) throw new ApiError(503, created.code, created.error);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: created.data.getId(),
        sandbox_status: SandboxStatus.RUNNING,
        setup_status: "PROVISIONING",
      },
    });
    this.startProvisioning(projectId);
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
      const recovered = await this.containers.recover(projectId, toSandboxProfile(project.sandbox_type));
      if (!recovered.ok) return recovered;
      sandbox = this.containers.get(projectId);
    }
    return sandbox;
  }

  private startProvisioning(projectId: string): void {
    if (this.setups.has(projectId)) return;
    const version = (this.setupVersions.get(projectId) ?? 0) + 1;
    this.setupVersions.set(projectId, version);
    const setup = this.runProvisioning(projectId, version)
      .catch((error: unknown) => {
        console.error(
          `Project setup lifecycle failed for ${projectId}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (this.setupVersions.get(projectId) === version) this.setups.delete(projectId);
      });
    this.setups.set(projectId, setup);
  }

  private async runProvisioning(projectId: string, version: number): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || !this.isCurrentSetup(projectId, version)) return;
    const writeLog = async (message: string) => {
      if (!this.isCurrentSetup(projectId, version)) return;
      const current = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { setup_log: true },
      });
      if (!current || !this.isCurrentSetup(projectId, version)) return;
      const line = redactTextSecrets(message.trim());
      const setupLog = `${current.setup_log}${line}\n`.slice(-80_000);
      await this.prisma.project.update({
        where: { id: projectId },
        data: { setup_log: setupLog },
      });
    };

    const previousAttempts = project.setup_attempts ?? 0;
    let attemptInCycle = 0;
    while (attemptInCycle < 2) {
      attemptInCycle += 1;
      const attempts = previousAttempts + attemptInCycle;
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          setup_status: "PROVISIONING",
          setup_error: null,
          setup_attempts: attempts,
        },
      });
      try {
        const detectedSetup = await this.setupRunner.prepare(project, writeLog);
        if (!this.isCurrentSetup(projectId, version)) return;
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            setup_status: "READY",
            setup_log: `${(await this.prisma.project.findUniqueOrThrow({
              where: { id: projectId },
              select: { setup_log: true },
            })).setup_log}Provisioning complete: ${detectedSetup}.\n`.slice(-80_000),
            setup_error: null,
            setup_attempts: attempts,
            detected_setup: detectedSetup,
            workspace_ready: true,
          },
        });
        return;
      } catch (error) {
        if (!this.isCurrentSetup(projectId, version)) return;
        const reason = error instanceof Error ? error.message : "Project setup failed";
        const transient = error instanceof ProjectSetupError && error.transient;
        await writeLog(`Setup attempt ${attempts} failed: ${reason}`);
        if (transient && attemptInCycle === 1) {
          await writeLog("A transient failure was detected; retrying setup once.");
          continue;
        }
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            setup_status: "FAILED",
            setup_error: redactTextSecrets(reason),
            setup_attempts: attempts,
            workspace_ready: false,
          },
        });
        return;
      }
    }
  }

  private isCurrentSetup(projectId: string, version: number): boolean {
    return this.setupVersions.get(projectId) === version;
  }

  private invalidateSetup(projectId: string): void {
    this.setupVersions.set(projectId, (this.setupVersions.get(projectId) ?? 0) + 1);
    this.setups.delete(projectId);
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
  setup_status?: string;
  setup_log?: string;
  setup_error?: string | null;
  setup_attempts?: number;
  detected_setup?: string | null;
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
    setup_status: toSetupStatus(project.setup_status ?? (project.workspace_ready ? "READY" : "PENDING")),
    setup_log: project.setup_log ?? "",
    setup_error: project.setup_error ?? null,
    setup_attempts: project.setup_attempts ?? 0,
    detected_setup: project.detected_setup ?? null,
    created_at: project.created_at,
  };
}

function toSetupStatus(status: string): ProjectSetupStatus {
  switch (status) {
    case "PENDING":
    case "PROVISIONING":
    case "READY":
    case "FAILED":
      return status;
    default:
      throw new Error(`Unknown project setup status: ${status}`);
  }
}

function toSandboxProfile(value: string): "node" | "minimal" {
  if (value === "node" || value === "minimal") return value;
  throw new Error(`Unknown sandbox profile: ${value}`);
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