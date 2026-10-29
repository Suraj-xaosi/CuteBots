import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode, type Result } from "@workspace/types";
import { commandError, runDocker } from "./docker.js";
import { Sandbox } from "./sandbox.js";

const IMAGE_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;

export class ContainerManager {
  private static instance: ContainerManager | undefined;
  private readonly sandboxes = new Map<string, Sandbox>();
  private imageBuild: Promise<Result<void>> | undefined;

  private constructor() {}

  static getInstance(): ContainerManager {
    this.instance ??= new ContainerManager();
    return this.instance;
  }

  async create(projectId: string): Promise<Result<Sandbox>> {
    const existing = this.sandboxes.get(projectId);
    if (existing) return { ok: true, data: existing };

    const image = await this.ensureSandboxImage();
    if (!image.ok) return image;

    const network = await this.ensureSandboxNetwork();
    if (!network.ok) return network;

    const sandbox = new Sandbox(projectId);
    const result = await sandbox.create();
    if (!result.ok) return result;

    this.sandboxes.set(projectId, sandbox);
    return { ok: true, data: sandbox };
  }

  get(projectId: string): Result<Sandbox> {
    const sandbox = this.sandboxes.get(projectId);
    if (!sandbox) {
      return {
        ok: false,
        error: `Sandbox for project ${projectId} is not attached`,
        code: ErrorCode.CONTAINER_NOT_FOUND,
      };
    }
    return { ok: true, data: sandbox };
  }

  async destroy(projectId: string): Promise<Result<void>> {
    const sandbox = this.sandboxes.get(projectId) ?? new Sandbox(projectId);
    const result = await sandbox.destroy();
    if (result.ok) this.sandboxes.delete(projectId);
    return result;
  }

  async stop(projectId: string): Promise<Result<void>> {
    const sandbox = this.sandboxes.get(projectId) ?? new Sandbox(projectId);
    const result = await sandbox.stop();
    if (result.ok) this.sandboxes.delete(projectId);
    return result;
  }

  async recover(projectId: string): Promise<Result<void>> {
    const sandbox = new Sandbox(projectId);
    const result = await sandbox.recover();
    if (result.ok) this.sandboxes.set(projectId, sandbox);
    return result;
  }

  async cleanupStale(activeProjectIds: ReadonlySet<string>): Promise<Result<void>> {
    const listed = await runDocker([
      "ps",
      "-aq",
      "--filter",
      "label=cute-bots.sandbox=true",
    ]);
    if (listed.exitCode !== 0 || listed.timedOut) {
      return this.failure(commandError(listed));
    }

    for (const containerId of listed.stdout.split(/\s+/).filter(Boolean)) {
      const inspected = await runDocker([
        "inspect",
        "--format",
        '{{ index .Config.Labels "cute-bots.project-id" }}',
        containerId,
      ]);
      if (inspected.exitCode !== 0) {
        return this.failure(commandError(inspected));
      }

      const projectId = inspected.stdout.trim();
      if (activeProjectIds.has(projectId)) continue;

      const removed = await runDocker(["rm", "-f", containerId]);
      if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
        return this.failure(commandError(removed));
      }
      this.sandboxes.delete(projectId);
    }

    return { ok: true, data: undefined };
  }

  private failure(error: string): Result<void> {
    return {
      ok: false,
      error: error || "Docker command failed",
      code: ErrorCode.CONTAINER_EXEC_FAILED,
    };
  }

  private async ensureSandboxImage(): Promise<Result<void>> {
    const imageName = process.env.SANDBOX_IMAGE ?? "cutebots-sandbox-base:latest";
    const inspected = await runDocker(["image", "inspect", imageName]);
    if (inspected.exitCode === 0) return { ok: true, data: undefined };

    const inspectError = commandError(inspected);
    if (!/no such image|image not found/i.test(inspectError)) {
      return this.failure(`Unable to inspect sandbox image ${imageName}: ${inspectError}`);
    }

    if (!this.imageBuild) {
      this.imageBuild = this.buildSandboxImage(imageName)
        .finally(() => {
          this.imageBuild = undefined;
        });
    }
    return this.imageBuild;
  }

  private async buildSandboxImage(imageName: string): Promise<Result<void>> {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const dockerfile = resolve(repositoryRoot, "infra", "Dockerfile.sandbox-base");
    if (!existsSync(dockerfile)) {
      return this.failure(`Sandbox image is missing and its Dockerfile was not found: ${dockerfile}`);
    }

    const built = await runDocker(
      ["build", "--file", dockerfile, "--tag", imageName, repositoryRoot],
      { timeoutMs: IMAGE_BUILD_TIMEOUT_MS },
    );
    if (built.exitCode !== 0 || built.timedOut || built.spawnError || built.outputLimitExceeded) {
      return this.failure(
        `Unable to build sandbox image ${imageName}: ${commandError(built) || "Docker build failed"}`,
      );
    }
    return { ok: true, data: undefined };
  }

  private async ensureSandboxNetwork(): Promise<Result<void>> {
    const networkName = process.env.SANDBOX_NETWORK ?? "sandbox-net";
    const inspected = await runDocker(["network", "inspect", networkName]);
    if (inspected.exitCode === 0) return { ok: true, data: undefined };
    if (!/no such network|network .+ not found/i.test(commandError(inspected))) {
      return this.failure(commandError(inspected));
    }

    const created = await runDocker(["network", "create", "--driver", "bridge", networkName]);
    if (created.exitCode === 0) return { ok: true, data: undefined };

    const raced = await runDocker(["network", "inspect", networkName]);
    if (raced.exitCode === 0) return { ok: true, data: undefined };
    return this.failure(commandError(created));
  }
}