import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: Error;
}

export function runDocker(
  args: string[],
  options: { input?: string | Buffer; timeoutMs?: number } = {},
): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      stdoutChunks.push(chunk.subarray(0, Math.max(remaining, 0)));
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      stderrChunks.push(chunk.subarray(0, Math.max(remaining, 0)));
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill();
      }
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        outputLimitExceeded,
        spawnError,
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export function commandError(result: DockerCommandResult): string {
  if (result.timedOut) return "Docker command timed out";
  if (result.outputLimitExceeded) return "Docker command output exceeded the 5 MB limit";
  if (result.spawnError) return result.spawnError.message;
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

export function commandOutput(result: DockerCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd();
  if (!output) return `Command exited with code ${result.exitCode ?? "unknown"}`;
  if (result.exitCode !== 0) {
    return `${output}\nCommand exited with code ${result.exitCode ?? "unknown"}`;
  }
  return output;
}

export function isDockerTransportError(result: DockerCommandResult): boolean {
  return /cannot connect to the docker daemon|error response from daemon|no such container|container is not running/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}