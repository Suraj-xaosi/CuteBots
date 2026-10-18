import { ErrorCode, SandboxStatus } from "@workspace/types";
import { ContainerManager, cloneGitHubRepository, redactTextSecrets } from "@workspace/core";
import { PrismaClient } from "@workspace/db";
import { SecretVault } from "../security/secret-vault.js";

const PROJECT_BRANCH_PREFIX = "cutebots";

export class ProjectProvisioner {
  private readonly provisions = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly containers: ContainerManager,
    private readonly createVault: () => SecretVault,
  ) {}

  isProvisioning(projectId: string): boolean {
    return this.provisions.has(projectId);
  }

  start(projectId: string): void {
    if (this.provisions.has(projectId)) return;
    const provisioning = this.provision(projectId)
      .catch(async (error: unknown) => {
        const reason = error instanceof Error ? error.message : "Project provisioning failed";
        await this.markFailed(projectId, reason);
      })
      .finally(() => this.provisions.delete(projectId));
    this.provisions.set(projectId, provisioning);
  }

  async markFailed(projectId: string, error: string): Promise<void> {
    await this.prisma.project.updateMany({
      where: { id: projectId },
      data: {
        provision_status: "FAILED",
        provision_error: redactTextSecrets(error),
      },
    });
  }

  private async provision(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("Project not found");
    let sandbox = this.containers.get(projectId);
    if (!sandbox.ok) {
      const recovered = await this.containers.recover(projectId);
      if (recovered.ok) {
        sandbox = this.containers.get(projectId);
      } else if (recovered.code === ErrorCode.CONTAINER_NOT_FOUND) {
        sandbox = await this.containers.create(projectId);
      } else {
        throw new Error(`Unable to recover project sandbox: ${recovered.error}`);
      }
    }
    if (!sandbox.ok) throw new Error(sandbox.error);

    const githubToken = project.github_token
      ? this.createVault().decrypt(project.github_token)
      : undefined;
    const cloned = await cloneGitHubRepository(sandbox.data, project.repo_url, project.id, githubToken);
    if (!cloned.success) throw new Error(`Repository clone failed: ${cloned.output}`);

    const branchName = project.branch_name ?? `${PROJECT_BRANCH_PREFIX}/${project.id}`;
    const created = await sandbox.data.exec(`git switch --create ${shellQuote(branchName)}`);
    if (!created.ok) {
      const switched = await sandbox.data.exec(`git switch -- ${shellQuote(branchName)}`);
      if (!switched.ok) throw new Error(`Unable to prepare project branch: ${switched.error}`);
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: sandbox.data.getId(),
        branch_name: branchName,
        sandbox_status: SandboxStatus.RUNNING,
        provision_status: "READY",
        provision_error: null,
      },
    });
  }

}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
