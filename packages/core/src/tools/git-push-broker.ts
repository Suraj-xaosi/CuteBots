import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "../sandbox.js";
import { shellQuote } from "./git-tool-utils.js";
import type { ToolResult } from "./tool.js";

const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const GIT_PUSH_TIMEOUT_MS = 2 * 60 * 1_000;

export type GitCommandRunner = (
  args: string[],
  cwd: string,
  extraEnvironment?: Record<string, string>,
) => Promise<{ exitCode: number | null; output: string }>;

export interface GitPushService {
  push(taskId: string, branch: string, sandbox: Sandbox): Promise<ToolResult>;
}

export class GitPushBroker implements GitPushService {
  constructor(
    private readonly repositoryUrl: string,
    private readonly writeToken: string | undefined,
    private readonly executeGit: GitCommandRunner = runGit,
  ) {}

  async push(taskId: string, branch: string, sandbox: Sandbox): Promise<ToolResult> {
    const expectedBranch = `agent/${taskId}`;
    if (!isSafeTaskId(taskId) || branch !== expectedBranch) {
      return { success: false, output: "Push broker accepts only this task's agent branch" };
    }
    if (!this.writeToken) {
      return { success: false, output: "Host-side GitHub write token is not configured" };
    }
    const repository = parseRepositoryUrl(this.repositoryUrl);
    if (!repository) {
      return { success: false, output: "Repository URL must be a clean HTTPS GitHub URL" };
    }

    const bundle = await sandbox.exportBranchBundle(branch);
    if (!bundle.ok) return { success: false, output: bundle.error };

    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cutebots-git-push-"));
      const bundlePath = path.join(temporaryDirectory, "task.bundle");
      const repositoryPath = path.join(temporaryDirectory, "repository.git");
      const credentialHelperPath = path.join(temporaryDirectory, "credential-helper");
      await writeFile(bundlePath, bundle.data, { mode: 0o600 });
      await writeFile(credentialHelperPath, createCredentialHelper(this.writeToken), { mode: 0o700 });
      await chmod(temporaryDirectory, 0o700);

      const clone = await this.executeGit(["clone", "--bare", bundlePath, repositoryPath], temporaryDirectory);
      if (clone.exitCode !== 0) return this.failed(clone.output);

      const setRemote = await this.executeGit(
        ["-C", repositoryPath, "remote", "set-url", "origin", repository.cloneUrl],
        temporaryDirectory,
      );
      if (setRemote.exitCode !== 0) return this.failed(setRemote.output);

      const push = await this.executeGit([
        "-c", "credential.helper=",
        "-c", `credential.helper=!${shellQuote(credentialHelperPath)}`,
        "-C", repositoryPath,
        "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`,
      ], temporaryDirectory, { GIT_TERMINAL_PROMPT: "0" });
      if (push.exitCode !== 0) return this.failed(push.output);
      return { success: true, output: push.output || `Pushed ${branch}` };
    } catch (error) {
      return this.failed(error instanceof Error ? error.message : "Host-side Git push failed");
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private failed(output: string): ToolResult {
    return {
      success: false,
      output: this.writeToken ? output.split(this.writeToken).join("***") : output,
    };
  }
}

function runGit(
  args: string[],
  cwd: string,
  extraEnvironment: Record<string, string> = {},
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_PUSH_TIMEOUT_MS);

    const capture = (chunk: Buffer) => {
      if (bytes < MAX_GIT_OUTPUT_BYTES) {
        const kept = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - bytes);
        output.push(kept);
        bytes += kept.byteLength;
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => output.push(Buffer.from(error.message)));
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const detail = Buffer.concat(output).toString("utf8").trim();
      resolve({
        exitCode: timedOut ? null : exitCode,
        output: timedOut ? `${detail}\nGit push timed out`.trim() : detail,
      });
    });
  });
}

function parseRepositoryUrl(value: string): { cloneUrl: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment.replace(/\.git$/i, "")))) {
      return undefined;
    }
    const [owner, repository] = segments;
    if (!owner || !repository) return undefined;
    return { cloneUrl: `https://github.com/${owner}/${repository.replace(/\.git$/i, "")}.git` };
  } catch {
    return undefined;
  }
}

function createCredentialHelper(token: string): string {
  const encodedToken = Buffer.from(token, "utf8").toString("base64");
  return [
    "#!/bin/sh",
    'if [ "$1" = get ]; then',
    '  printf "%s\\n" "username=x-access-token"',
    `  printf "%s\\n" "password=$(printf %s '${encodedToken}' | base64 -d)"`,
    "fi",
    "",
  ].join("\n");
}

function isSafeTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(taskId);
}
