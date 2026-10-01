import { ErrorCode, type Result } from "@workspace/types";
import { commandError, commandOutput, isDockerTransportError, runDocker } from "./docker.js";
import { SandboxCommandJobs, type CommandJobSnapshot } from "./sandbox/command-jobs.js";
import { SandboxFileOperations } from "./sandbox/file-operations.js";
import { COMMAND_FOREGROUND_TIMEOUT_MS, WORKSPACE_ROOT } from "./sandbox/constants.js";

export type { CommandJobSnapshot } from "./sandbox/command-jobs.js";

export class Sandbox {
  private containerId: string | null = null;
  private readonly containerName: string;
  private readonly commandJobs: SandboxCommandJobs;
  private readonly fileOperations: SandboxFileOperations;

  constructor(private readonly projectId: string) {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.containerName = `sandbox-${safeProjectId}`;
    this.commandJobs = new SandboxCommandJobs(() => this.containerId);
    this.fileOperations = new SandboxFileOperations(() => this.containerId);
  }

  async create(): Promise<Result<void>> {
    const result = await runDocker([
      "run",
      "-d",
      "--name",
      this.containerName,
      "--label",
      "cute-bots.sandbox=true",
      "--label",
      `cute-bots.project-id=${this.projectId}`,
      "--network",
      process.env.SANDBOX_NETWORK ?? "sandbox-net",
      "--memory",
      "512m",
      "--cpus",
      "0.5",
      "--workdir",
      WORKSPACE_ROOT,
      process.env.SANDBOX_IMAGE ?? "cutebots-sandbox-node:latest",
    ]);

    if (result.exitCode === 0) {
      this.containerId = result.stdout.trim();
      return { ok: true, data: undefined };
    }

    if (/already in use|name is already in use|conflict/i.test(result.stderr)) {
      return this.recover();
    }

    return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
  }

  async recover(): Promise<Result<void>> {
    const inspect = await runDocker([
      "inspect",
      "--format",
      "{{.Id}}",
      this.containerName,
    ]);

    if (inspect.exitCode !== 0) {
      return this.failure(
        commandError(inspect) || "Container not found",
        ErrorCode.CONTAINER_NOT_FOUND,
      );
    }

    const start = await runDocker(["start", this.containerName]);
    if (start.exitCode !== 0) {
      return this.failure(commandError(start), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    this.containerId = inspect.stdout.trim();
    return { ok: true, data: undefined };
  }

  async exec(command: string, timeoutMs = COMMAND_FOREGROUND_TIMEOUT_MS): Promise<Result<string>> {
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker(
      ["exec", this.containerId, "bash", "-lc", command],
      { timeoutMs },
    );

    if (result.timedOut) {
      return this.failure(commandError(result), ErrorCode.SANDBOX_TIMEOUT);
    }
    if (result.spawnError || result.outputLimitExceeded || isDockerTransportError(result)) {
      return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    return { ok: true, data: commandOutput(result) };
  }

  async runCommand(
    command: string,
    options: { foregroundTimeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<Result<CommandJobSnapshot>> {
    return this.commandJobs.runCommand(command, options);
  }

  async pollCommand(jobId: string, offset = 0): Promise<Result<CommandJobSnapshot>> {
    return this.commandJobs.pollCommand(jobId, offset);
  }

  async cancelCommand(jobId: string): Promise<Result<void>> {
    return this.commandJobs.cancelCommand(jobId);
  }

  async writeFile(filePath: string, content: string): Promise<Result<void>> {
    return this.fileOperations.writeFile(filePath, content);
  }

  async readFile(filePath: string): Promise<Result<string>> {
    return this.fileOperations.readFile(filePath);
  }

  async listFiles(directoryPath: string): Promise<Result<string>> {
    return this.fileOperations.listFiles(directoryPath);
  }

  async exportBranchBundle(branch: string): Promise<Result<Buffer>> {
    return this.fileOperations.exportBranchBundle(branch);
  }

  async destroy(): Promise<Result<void>> {
    const result = await runDocker(["rm", "-f", this.containerId ?? this.containerName]);
    if (
      result.exitCode !== 0 &&
      !/no such container|no such object/i.test(`${result.stderr}\n${result.stdout}`)
    ) {
      return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    this.containerId = null;
    return { ok: true, data: undefined };
  }

  setId(id: string): void {
    this.containerId = id;
  }

  getId(): string | null {
    return this.containerId;
  }

  getName(): string {
    return this.containerName;
  }

  private failure<T>(error: string, code: ErrorCode): Result<T> {
    return { ok: false, error: error || "Docker command failed", code };
  }
}
