import { ErrorCode, SandboxStatus, TaskStatus, type Result } from "@workspace/types";
import { ContainerManager, type Sandbox } from "@workspace/core";
import { PrismaClient } from "@workspace/db";
import { ApiError } from "../http/api-error.js";
import { SecretVault } from "../security/secret-vault.js";
import { isGitHubRepositoryUrl, toPublicProject } from "./project-mappers.js";
import { ProjectProvisioner } from "./project-provisioner.js";

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  github_token?: string;
}

export type ProjectProvisionStatus = "PENDING" | "PROVISIONING" | "READY" | "FAILED";

export interface PublicProject {
  id: string;
  name: string;
  repo_url: string;
  context: string;
  github_token_configured: boolean;
  container_id: string | null;
  branch_name: string | null;
  sandbox_status: SandboxStatus;
  provision_status: ProjectProvisionStatus;
  provision_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export class ProjectService {
  private readonly provisioner: ProjectProvisioner;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly containers: ContainerManager,
    private readonly vaultFactory: () => SecretVault = () => new SecretVault(),
  ) {
    this.provisioner = new ProjectProvisioner(prisma, containers, vaultFactory);
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

  async updateContext(projectId: string, context: string): Promise<PublicProject> {
    await this.findProject(projectId);
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { context: context.trim() },
    });
    return toPublicProject(project);
  }

  async updateGithubToken(projectId: string, token: string): Promise<PublicProject> {
    const project = await this.findProject(projectId);
    const updated = await this.prisma.project.update({
      where: { id: project.id },
      data: { github_token: this.createVault().encrypt(token) },
    });
    return toPublicProject(updated);
  }

  async create(input: CreateProjectInput): Promise<PublicProject> {
    if (!isGitHubRepositoryUrl(input.repo_url)) {
      throw new ApiError(400, ErrorCode.GITHUB_API_FAILED, "Repository URL must be a clean HTTPS GitHub URL");
    }

    const vault = input.github_token ? this.createVault() : undefined;
    const project = await this.prisma.project.create({
      data: {
        name: input.name.trim(),
        repo_url: input.repo_url,
        github_token: input.github_token ? vault!.encrypt(input.github_token) : null,
        branch_name: null,
        provision_status: "PROVISIONING",
      },
    });

    this.provisioner.start(project.id);
    return toPublicProject(project);
  }

  async recoverOnStartup(): Promise<void> {
    await this.prisma.task.updateMany({
      where: { status: TaskStatus.RUNNING },
      data: {
        status: TaskStatus.INTERRUPTED,
        fail_reason: "Agent server restarted; task history and project workspace were preserved.",
      },
    });
    await this.prisma.project.updateMany({ data: { active_task_id: null } });

    const projects = await this.prisma.project.findMany({
      where: {
        OR: [
          { sandbox_status: SandboxStatus.RUNNING },
          { provision_status: "PROVISIONING" },
        ],
      },
      select: { id: true, container_id: true, provision_status: true },
    });
    const retainedIds = new Set<string>();

    for (const project of projects) {
      retainedIds.add(project.id);
      let recovered = await this.containers.recover(project.id);
      if (!recovered.ok && recovered.code === ErrorCode.CONTAINER_NOT_FOUND) {
        const created = await this.containers.create(project.id);
        if (!created.ok) {
          await this.provisioner.markFailed(project.id, created.error);
          continue;
        }
        await this.prisma.project.update({
          where: { id: project.id },
          data: { container_id: created.data.getId(), provision_status: "PROVISIONING" },
        });
        this.provisioner.start(project.id);
        continue;
      }
      if (!recovered.ok) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { sandbox_status: SandboxStatus.STOPPED },
        });
        continue;
      }

      if (project.provision_status !== "READY") this.provisioner.start(project.id);
    }
    const cleaned = await this.containers.cleanupStale(retainedIds);
    if (!cleaned.ok) {
      throw new Error(
        `Unable to access the Docker Engine while checking project sandboxes. Start or restart Docker Desktop, confirm "docker ps" succeeds, then restart CuteBots. Docker error: ${cleaned.error}`,
      );
    }
  }

  async startSandbox(projectId: string): Promise<PublicProject> {
    const project = await this.findProject(projectId);
    if (project.sandbox_status === SandboxStatus.RUNNING) return toPublicProject(project);

    let sandbox = this.containers.get(projectId);
    let needsProvisioning = false;
    if (!sandbox.ok) {
      const recovered = await this.containers.recover(projectId);
      if (recovered.ok) {
        sandbox = this.containers.get(projectId);
      } else if (recovered.code === ErrorCode.CONTAINER_NOT_FOUND) {
        sandbox = await this.containers.create(projectId);
        needsProvisioning = sandbox.ok;
      } else {
        throw new ApiError(503, recovered.code, recovered.error);
      }
    }
    if (!sandbox.ok) throw new ApiError(503, sandbox.code, sandbox.error);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: sandbox.data.getId(),
        sandbox_status: SandboxStatus.RUNNING,
        ...(needsProvisioning || project.provision_status !== "READY"
          ? { provision_status: "PROVISIONING", provision_error: null }
          : {}),
      },
    });
    if (needsProvisioning || project.provision_status !== "READY") this.provisioner.start(projectId);
    return toPublicProject(updated);
  }

  async destroySandbox(projectId: string): Promise<PublicProject> {
    const project = await this.findProject(projectId);
    if (project.active_task_id) {
      throw new ApiError(409, ErrorCode.TASK_ALREADY_RUNNING, "Interrupt the active task before destroying its sandbox");
    }
    if (this.provisioner.isProvisioning(projectId)) {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Wait for repository cloning to finish before destroying its sandbox");
    }
    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: null,
        sandbox_status: SandboxStatus.STOPPED,
        provision_status: "PENDING",
        provision_error: null,
      },
    });
    return toPublicProject(updated);
  }

  async retryProvisioning(projectId: string): Promise<PublicProject> {
    const project = await this.findProject(projectId);
    if (project.provision_status !== "FAILED") {
      throw new ApiError(409, ErrorCode.TOOL_EXECUTION_FAILED, "Only failed project provisioning can be retried");
    }
    if (project.sandbox_status !== SandboxStatus.RUNNING) {
      throw new ApiError(409, ErrorCode.CONTAINER_NOT_FOUND, "Start the project sandbox before retrying provisioning");
    }
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { provision_status: "PROVISIONING", provision_error: null },
    });
    this.provisioner.start(projectId);
    return toPublicProject(updated);
  }

  async destroy(projectId: string): Promise<void> {
    const project = await this.findProject(projectId);
    if (project.active_task_id) {
      throw new ApiError(409, ErrorCode.TASK_ALREADY_RUNNING, "Interrupt the active task before deleting this project");
    }
    const destroyed = await this.containers.destroy(projectId);
    if (!destroyed.ok) throw new ApiError(503, destroyed.code, destroyed.error);
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  async getSandbox(projectId: string): Promise<Result<Sandbox>> {
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

  private async findProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError(404, ErrorCode.TASK_NOT_FOUND, "Project not found");
    return project;
  }

  private createVault(): SecretVault {
    try {
      return this.vaultFactory();
    } catch (error) {
      throw new ApiError(
        500,
        ErrorCode.INVALID_API_KEY,
        error instanceof Error ? error.message : "Secret encryption is not configured",
      );
    }
  }

}
