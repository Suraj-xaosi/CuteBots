import { mkdtemp, readFile as readHostFile, rm, writeFile as writeHostFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pathPosix from "node:path/posix";
import { ErrorCode, type Result } from "@workspace/types";
import { commandError, runDocker } from "../docker.js";
import { FILE_OP_TIMEOUT_MS, WORKSPACE_ROOT } from "./constants.js";

const LARGE_FILE_BYTES = 100 * 1024;

export class SandboxFileOperations {
  constructor(private readonly getContainerId: () => string | null) {}

  async writeFile(filePath: string, content: string): Promise<Result<void>> {
    const absolutePath = this.resolveWorkspacePath(filePath);
    if (!absolutePath) {
      return this.failure("File path must stay inside /workspace", ErrorCode.CONTAINER_EXEC_FAILED);
    }
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const parentDirectory = pathPosix.dirname(absolutePath);
    const makeDirectory = await runDocker([
      "exec",
      containerId,
      "mkdir",
      "-p",
      parentDirectory,
    ]);
    if (makeDirectory.exitCode !== 0) {
      return this.failure(commandError(makeDirectory), ErrorCode.CONTAINER_EXEC_FAILED);
    }

    if (Buffer.byteLength(content, "utf8") > LARGE_FILE_BYTES) {
      return this.writeLargeFile(containerId, absolutePath, content);
    }

    const result = await runDocker(
      [
        "exec",
        "-i",
        containerId,
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
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker(
      ["exec", containerId, "cat", "--", absolutePath],
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
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const result = await runDocker(
      [
        "exec",
        containerId,
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
    const containerId = this.getContainerId();
    if (!containerId) {
      return this.failure("Sandbox has not been created", ErrorCode.CONTAINER_NOT_FOUND);
    }

    const bundleId = randomUUID();
    const containerBundlePath = `/tmp/cutebots-${bundleId}.bundle`;
    const createBundle = await runDocker([
      "exec", containerId, "git", "bundle", "create", containerBundlePath,
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
        ["cp", `${containerId}:${containerBundlePath}`, hostBundlePath],
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
      await runDocker(["exec", containerId, "rm", "-f", containerBundlePath]);
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
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

  private async writeLargeFile(
    containerId: string,
    absolutePath: string,
    content: string,
  ): Promise<Result<void>> {
    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sandbox-file-"));
      const temporaryFile = path.join(temporaryDirectory, "content");
      await writeHostFile(temporaryFile, content, "utf8");
      const result = await runDocker(
        ["cp", temporaryFile, `${containerId}:${absolutePath}`],
        { timeoutMs: FILE_OP_TIMEOUT_MS },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        return this.failure(commandError(result), this.errorCodeFor(result));
      }

      const ownership = await runDocker([
        "exec",
        containerId,
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
