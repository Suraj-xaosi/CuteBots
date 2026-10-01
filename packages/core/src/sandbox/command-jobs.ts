import { randomUUID } from "node:crypto";
import { ErrorCode, type Result } from "@workspace/types";
import { commandError, runDocker } from "../docker.js";
import {
  COMMAND_JOB_CANCEL_SCRIPT,
  COMMAND_JOB_MAX_AGE_MS,
  COMMAND_JOB_POLL_SCRIPT,
  COMMAND_JOB_START_SCRIPT,
} from "./command-job-scripts.js";
import { COMMAND_FOREGROUND_TIMEOUT_MS } from "./constants.js";

const COMMAND_POLL_INTERVAL_MS = 1_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 5 * 1024 * 1024;
const COMMAND_POLL_CHUNK_BYTES = 64 * 1024;

export interface CommandJobSnapshot {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  output: string;
  nextOffset: number;
  exitCode: number | null;
  outputTruncated: boolean;
}

export class SandboxCommandJobs {
  constructor(private readonly getContainerId: () => string | null) {}

  async runCommand(
    command: string,
    options: { foregroundTimeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<Result<CommandJobSnapshot>> {
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const jobId = randomUUID();
    const started = await runDocker([
      "exec", "-d", containerId, "node", "-e", COMMAND_JOB_START_SCRIPT,
      jobId, command, String(COMMAND_OUTPUT_LIMIT_BYTES),
    ]);
    if (started.exitCode !== 0 || started.spawnError) {
      return this.failure(commandError(started), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    const deadline = Date.now() + (options.foregroundTimeoutMs ?? COMMAND_FOREGROUND_TIMEOUT_MS);
    const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? COMMAND_POLL_INTERVAL_MS);
    let offset = 0;
    let output = "";
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        return this.cancelledCommandResult(jobId, offset, output);
      }
      const snapshot = await this.pollCommand(jobId, offset);
      if (!snapshot.ok) return snapshot;
      output += snapshot.data.output;
      offset = snapshot.data.nextOffset;
      if (snapshot.data.status !== "running") {
        return { ok: true, data: { ...snapshot.data, output } };
      }
      await waitForInterval(
        Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)),
        options.signal,
      );
    }
    if (options.signal?.aborted) return this.cancelledCommandResult(jobId, offset, output);

    const snapshot = await this.pollCommand(jobId, offset);
    if (!snapshot.ok) return snapshot;
    output += snapshot.data.output;
    return { ok: true, data: { ...snapshot.data, output } };
  }

  async pollCommand(jobId: string, offset = 0): Promise<Result<CommandJobSnapshot>> {
    if (!isValidJobId(jobId) || !Number.isSafeInteger(offset) || offset < 0 || offset > COMMAND_OUTPUT_LIMIT_BYTES) {
      return this.failure("Invalid command job ID or output offset", ErrorCode.TOOL_EXECUTION_FAILED);
    }
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker([
      "exec", containerId, "node", "-e", COMMAND_JOB_POLL_SCRIPT,
      jobId, String(offset), String(COMMAND_POLL_CHUNK_BYTES), String(COMMAND_JOB_MAX_AGE_MS),
    ]);
    if (result.exitCode !== 0 || result.spawnError) {
      return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
    }
    try {
      return { ok: true, data: JSON.parse(result.stdout) as CommandJobSnapshot };
    } catch {
      return this.failure("Sandbox returned invalid command job status", ErrorCode.CONTAINER_EXEC_FAILED);
    }
  }

  async cancelCommand(jobId: string): Promise<Result<void>> {
    if (!isValidJobId(jobId)) {
      return this.failure("Invalid command job ID", ErrorCode.TOOL_EXECUTION_FAILED);
    }
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker([
      "exec", containerId, "node", "-e", COMMAND_JOB_CANCEL_SCRIPT, jobId,
    ]);
    if (result.exitCode !== 0) return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
    return { ok: true, data: undefined };
  }

  private async cancelledCommandResult(
    jobId: string,
    offset: number,
    output: string,
  ): Promise<Result<CommandJobSnapshot>> {
    const cancelled = await this.cancelCommand(jobId);
    if (!cancelled.ok) return cancelled;

    let collectedOutput = output;
    let currentOffset = offset;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = await this.pollCommand(jobId, currentOffset);
      if (!snapshot.ok) return snapshot;
      collectedOutput += snapshot.data.output;
      currentOffset = snapshot.data.nextOffset;
      if (snapshot.data.status !== "running") {
        return { ok: true, data: { ...snapshot.data, output: collectedOutput } };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.failure("Command process group did not stop after cancellation", ErrorCode.SANDBOX_TIMEOUT);
  }

  private failure<T>(error: string, code: ErrorCode): Result<T> {
    return { ok: false, error: error || "Docker command failed", code };
  }
}

function isValidJobId(jobId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId);
}

function waitForInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
