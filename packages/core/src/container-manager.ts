import { ErrorCode, type Result } from "@workspace/types";
import { commandError, runDocker } from "./docker.js";
import { Sandbox } from "./sandbox.js";

export class ContainerManager {
  private static instance: ContainerManager | undefined;
  private readonly sandboxes = new Map<string, Sandbox>();

  private constructor() {}

  static getInstance(): ContainerManager {
    this.instance ??= new ContainerManager();
    return this.instance;
  }

  async create(projectId: string): Promise<Result<Sandbox>> {
    const existing = this.sandboxes.get(projectId);
    if (existing) return { ok: true, data: existing };

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
}