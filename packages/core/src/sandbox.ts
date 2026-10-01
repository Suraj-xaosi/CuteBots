import { mkdtemp, readFile as readHostFile, rm, writeFile as writeHostFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pathPosix from "node:path/posix";
import { ErrorCode, type Result } from "@workspace/types";
import { commandError, commandOutput, isDockerTransportError, runDocker } from "./docker.js";

const WORKSPACE_ROOT = "/workspace";
const LARGE_FILE_BYTES = 100 * 1024;
const FILE_OP_TIMEOUT_MS = 30_000;
const COMMAND_FOREGROUND_TIMEOUT_MS = 5 * 60 * 1_000;
const COMMAND_POLL_INTERVAL_MS = 1_000;
const COMMAND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
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

export class Sandbox {
  private containerId: string | null = null;
  private readonly containerName: string;

  constructor(private readonly projectId: string) {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.containerName = `sandbox-${safeProjectId}`;
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
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const jobId = randomUUID();
    const started = await runDocker([
      "exec", "-d", this.containerId, "node", "-e", COMMAND_JOB_START_SCRIPT,
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

  async pollCommand(jobId: string, offset = 0): Promise<Result<CommandJobSnapshot>> {
    if (!isValidJobId(jobId) || !Number.isSafeInteger(offset) || offset < 0 || offset > COMMAND_OUTPUT_LIMIT_BYTES) {
      return this.failure("Invalid command job ID or output offset", ErrorCode.TOOL_EXECUTION_FAILED);
    }
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker([
      "exec", this.containerId, "node", "-e", COMMAND_JOB_POLL_SCRIPT,
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
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker([
      "exec", this.containerId, "node", "-e", COMMAND_JOB_CANCEL_SCRIPT, jobId,
    ]);
    if (result.exitCode !== 0) return this.failure(commandError(result), ErrorCode.CONTAINER_EXEC_FAILED);
    return { ok: true, data: undefined };
  }

  async writeFile(filePath: string, content: string): Promise<Result<void>> {
    const absolutePath = this.resolveWorkspacePath(filePath);
    if (!absolutePath) {
      return this.failure("File path must stay inside /workspace", ErrorCode.CONTAINER_EXEC_FAILED);
    }
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const parentDirectory = pathPosix.dirname(absolutePath);
    const makeDirectory = await runDocker([
      "exec",
      this.containerId,
      "mkdir",
      "-p",
      parentDirectory,
    ]);
    if (makeDirectory.exitCode !== 0) {
      return this.failure(commandError(makeDirectory), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    if (Buffer.byteLength(content, "utf8") > LARGE_FILE_BYTES) {
      return this.writeLargeFile(absolutePath, content);
    }

    const result = await runDocker(
      [
        "exec",
        "-i",
        this.containerId,
        "sh",
        "-c",
        'cat > "$1"',
        "sandbox-write",
        absolutePath,
      ],
      { input: content, timeoutMs: FILE_OP_TIMEOUT_MS },
    );

    if (result.timedOut || result.exitCode !== 0) {
      return this.failure(commandError(result), this.errorCodeFor(result));
    }
    return { ok: true, data: undefined };
  }

  async readFile(filePath: string): Promise<Result<string>> {
    const absolutePath = this.resolveWorkspacePath(filePath);
    if (!absolutePath) {
      return this.failure("File path must stay inside /workspace", ErrorCode.CONTAINER_EXEC_FAILED);
    }
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker(
      ["exec", this.containerId, "cat", "--", absolutePath],
      { timeoutMs: FILE_OP_TIMEOUT_MS },
    );
    if (result.exitCode !== 0 || result.timedOut) {
      return this.failure(
        commandError(result) || `File not found: ${filePath}`,
        this.errorCodeFor(result),
      );
    }
    return { ok: true, data: result.stdout };
  }

  async listFiles(directoryPath: string): Promise<Result<string>> {
    const absolutePath = this.resolveWorkspacePath(directoryPath);
    if (!absolutePath) {
      return this.failure("Directory path must stay inside /workspace", ErrorCode.CONTAINER_EXEC_FAILED);
    }
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker(
      [
        "exec",
        this.containerId,
        "sh",
        "-c",
        'find "$1" -type d \\( -name node_modules -o -name .git -o -name dist -o -name build -o -name .next \\) -prune -o -type f -print | head -n 200',
        "sandbox-list",
        absolutePath,
      ],
      { timeoutMs: FILE_OP_TIMEOUT_MS },
    );

    if (result.timedOut || result.exitCode !== 0 || result.stderr.trim()) {
      return this.failure(commandError(result), this.errorCodeFor(result));
    }
    return { ok: true, data: result.stdout.trimEnd() };
  }

  async exportBranchBundle(branch: string): Promise<Result<Buffer>> {
    if (!/^agent\/[A-Za-z0-9_.-]+$/.test(branch)) {
      return this.failure("Only agent task branches can be exported", ErrorCode.GIT_PUSH_FAILED);
    }
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const bundleId = randomUUID();
    const containerBundlePath = `/tmp/cutebots-${bundleId}.bundle`;
    const createBundle = await runDocker([
      "exec", this.containerId, "git", "bundle", "create", containerBundlePath,
      `refs/heads/${branch}`,
    ], { timeoutMs: FILE_OP_TIMEOUT_MS });
    if (createBundle.exitCode !== 0) {
      return this.failure(commandError(createBundle), ErrorCode.GIT_PUSH_FAILED);
    }

    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cutebots-bundle-"));
      const hostBundlePath = path.join(temporaryDirectory, "task.bundle");
      const copied = await runDocker(
        ["cp", `${this.containerId}:${containerBundlePath}`, hostBundlePath],
        { timeoutMs: FILE_OP_TIMEOUT_MS },
      );
      if (copied.exitCode !== 0) {
        return this.failure(commandError(copied), ErrorCode.GIT_PUSH_FAILED);
      }
      return { ok: true, data: await readHostFile(hostBundlePath) };
    } catch (error) {
      return this.failure(
        error instanceof Error ? error.message : "Unable to export task branch bundle",
        ErrorCode.GIT_PUSH_FAILED,
      );
    } finally {
      await runDocker(["exec", this.containerId, "rm", "-f", containerBundlePath]);
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
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

  private resolveWorkspacePath(input: string): string | null {
    const normalized = input.startsWith(`${WORKSPACE_ROOT}/`) || input === WORKSPACE_ROOT
      ? pathPosix.normalize(input)
      : pathPosix.resolve(WORKSPACE_ROOT, input);

    if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
      return null;
    }
    return normalized;
  }

  private async writeLargeFile(absolutePath: string, content: string): Promise<Result<void>> {
    if (!this.containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sandbox-file-"));
      const temporaryFile = path.join(temporaryDirectory, "content");
      await writeHostFile(temporaryFile, content, "utf8");
      const result = await runDocker(
        ["cp", temporaryFile, `${this.containerId}:${absolutePath}`],
        { timeoutMs: FILE_OP_TIMEOUT_MS },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        return this.failure(commandError(result), this.errorCodeFor(result));
      }

      const ownership = await runDocker([
        "exec",
        this.containerId,
        "chown",
        "node:node",
        absolutePath,
      ]);
      if (ownership.exitCode !== 0) {
        return this.failure(commandError(ownership), ErrorCode.CONTAINER_EXEC_FAILED);
      }
      return { ok: true, data: undefined };
    } catch (error) {
      return this.failure(
        error instanceof Error ? error.message : "Unable to prepare the large file",
        ErrorCode.CONTAINER_EXEC_FAILED,
      );
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private errorCodeFor(result: { timedOut: boolean }): ErrorCode {
    return result.timedOut ? ErrorCode.SANDBOX_TIMEOUT : ErrorCode.CONTAINER_EXEC_FAILED;
  }

  private failure<T>(error: string, code: ErrorCode): Result<T> {
    return { ok: false, error: error || "Docker command failed", code };
  }
}

function isValidJobId(jobId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId);
}

const COMMAND_JOB_START_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const id = process.argv[1];
const command = process.argv[2];
const outputLimit = Number(process.argv[3]);
const root = '/tmp/cutebots-command-jobs';
const directory = path.join(root, id);
fs.mkdirSync(root, { recursive: true });
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  const entryPath = path.join(root, entry.name);
  try {
    if (Date.now() - fs.statSync(entryPath).mtimeMs > ${COMMAND_JOB_MAX_AGE_MS}) fs.rmSync(entryPath, { recursive: true, force: true });
  } catch {}
}
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'created'), String(Date.now()));
fs.writeFileSync(path.join(directory, 'status'), 'running');
const outputPath = path.join(directory, 'output');
const child = spawn('bash', ['-lc', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(path.join(directory, 'pid'), String(child.pid));
let written = 0;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const remaining = outputLimit - written;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      fs.appendFileSync(outputPath, kept);
      written += kept.length;
    }
    if (chunk.length > remaining) fs.writeFileSync(path.join(directory, 'truncated'), '1');
  });
}
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}, 30 * 60 * 1000);
child.on('error', (error) => {
  fs.writeFileSync(outputPath, String(error));
  fs.writeFileSync(path.join(directory, 'exit'), '127');
  fs.writeFileSync(path.join(directory, 'status'), 'failed');
  clearTimeout(timeout);
});
child.on('close', (code) => {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(directory, 'exit'), String(code ?? 1));
  const cancelled = fs.existsSync(path.join(directory, 'cancel-requested'));
  fs.writeFileSync(path.join(directory, 'status'), timedOut ? 'timed_out' : cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed');
});
`;

const COMMAND_JOB_POLL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const id = process.argv[1];
const offset = Number(process.argv[2]);
const limit = Number(process.argv[3]);
const maxAge = Number(process.argv[4]);
const directory = path.join('/tmp/cutebots-command-jobs', id);
if (!fs.existsSync(directory)) { process.stderr.write('Unknown or expired command job'); process.exit(2); }
const created = Number(fs.readFileSync(path.join(directory, 'created'), 'utf8'));
if (Date.now() - created > maxAge) { fs.rmSync(directory, { recursive: true, force: true }); process.stderr.write('Unknown or expired command job'); process.exit(2); }
const outputPath = path.join(directory, 'output');
const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
const available = Math.max(0, Math.min(size - offset, limit));
let output = '';
if (available > 0) {
  const fd = fs.openSync(outputPath, 'r');
  const buffer = Buffer.alloc(available);
  fs.readSync(fd, buffer, 0, available, offset);
  fs.closeSync(fd);
  output = buffer.toString('utf8');
}
const status = fs.readFileSync(path.join(directory, 'status'), 'utf8');
const exitPath = path.join(directory, 'exit');
process.stdout.write(JSON.stringify({
  jobId: id,
  status,
  output,
  nextOffset: offset + available,
  exitCode: fs.existsSync(exitPath) ? Number(fs.readFileSync(exitPath, 'utf8')) : null,
  outputTruncated: fs.existsSync(path.join(directory, 'truncated')),
}));
`;

const COMMAND_JOB_CANCEL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join('/tmp/cutebots-command-jobs', process.argv[1]);
if (!fs.existsSync(directory)) { process.stderr.write('Unknown or expired command job'); process.exit(2); }
const statusPath = path.join(directory, 'status');
if (fs.readFileSync(statusPath, 'utf8') !== 'running') process.exit(0);
fs.writeFileSync(path.join(directory, 'cancel-requested'), '1');
const pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
try { process.kill(-pid, 'SIGTERM'); } catch {}
for (let attempt = 0; attempt < 50; attempt++) {
  try { process.kill(-pid, 0); } catch { process.exit(0); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
try { process.kill(-pid, 'SIGKILL'); } catch {}
`;

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