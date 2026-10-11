import { createHash } from "node:crypto";
import type { Result } from "@workspace/types";
import type { CommandJobSnapshot, Sandbox } from "../sandbox.js";

const VERIFICATION_SCRIPTS = ["test", "typecheck", "lint", "build"] as const;
const COMMAND_START_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const BASELINE_BUDGET_MS = 5 * 60 * 1_000;
const COMMAND_POLL_INTERVAL_MS = 500;
const MAX_REPORTED_OUTPUT_CHARS = 12_000;

export type VerificationOutcome =
  | { status: "passed"; changedFiles: string[]; checks: VerificationCheck[]; skippedChecks: string[] }
  | { status: "failed"; changedFiles: string[]; checks: VerificationCheck[]; skippedChecks: string[] }
  | { status: "unavailable"; reason: string; changedFiles: string[]; checks?: VerificationCheck[]; skippedChecks: string[] }
  | { status: "no_changes"; changedFiles: [] };

export interface VerificationCheck {
  packagePath: string;
  script: string;
  command: string;
  passed: boolean;
  output: string;
  baseline: "passed" | "failed" | "unknown";
}

interface PackageManifest {
  packageManager?: string;
  scripts?: Record<string, unknown>;
}

interface PackageLocation {
  directory: string;
  manifest: PackageManifest;
}

interface CommandResult {
  passed: boolean;
  output: string;
  cancelled: boolean;
  indeterminate: boolean;
}

export class VerificationGate {
  private readonly baselineResults = new Map<string, "passed" | "failed" | "unknown">();
  private readonly baselineFileHashes = new Map<string, string>();
  private readonly baselinePackageScripts = new Map<string, Record<string, unknown>>();
  private readonly baselinePackageManagers = new Map<string, string | undefined>();
  private readonly baselineTestFiles = new Map<string, string>();
  private baselineHead: string | undefined;
  private baselineWorkspaceKnown = false;
  private baselineTestInventoryKnown = false;

  constructor(private readonly sandbox: Sandbox) {}

  async captureBaseline(signal?: AbortSignal): Promise<VerificationCheck[]> {
    this.baselineResults.clear();
    this.baselineFileHashes.clear();
    this.baselinePackageScripts.clear();
    this.baselinePackageManagers.clear();
    this.baselineTestFiles.clear();
    this.baselineHead = undefined;
    this.baselineWorkspaceKnown = false;
    this.baselineTestInventoryKnown = false;
    const manifests = await this.runCommand(
      "git ls-files --cached -- 'package.json' '**/package.json'",
      signal,
    );
    if (!manifests.passed || manifests.cancelled) return [];

    const manifestPaths = [...new Set(manifests.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    const locations = new Map<string, PackageManifest>();
    for (const manifestPath of manifestPaths) {
      if (!manifestPath.endsWith("/package.json") && manifestPath !== "package.json") continue;
      const directory = manifestPath === "package.json" ? "." : manifestPath.slice(0, -"/package.json".length);
      const manifest = await this.readManifest(directory);
      if (manifest) {
        locations.set(directory, manifest);
        this.baselinePackageScripts.set(directory, manifest.scripts ?? {});
        this.baselinePackageManagers.set(directory, manifest.packageManager);
      }
    }

    const root = locations.get(".");
    const packageManager = root ? await this.resolvePackageManager(root) : undefined;
    if (!packageManager) return [];

    const startedAt = Date.now();
    const checks: VerificationCheck[] = [];
    const orderedLocations = [...locations].sort(([left], [right]) =>
      left === "." ? 1 : right === "." ? -1 : left.localeCompare(right),
    );
    for (const [packagePath, manifest] of orderedLocations) {
      for (const script of VERIFICATION_SCRIPTS) {
        if (typeof manifest.scripts?.[script] !== "string") continue;
        const key = baselineKey(packagePath, script);
        const remainingMs = BASELINE_BUDGET_MS - (Date.now() - startedAt);
        if (remainingMs <= 0 || signal?.aborted) {
          this.baselineResults.set(key, "unknown");
          continue;
        }
        const command = buildCommand(packageManager, packagePath, script);
        const result = await this.runCommand(command, signal, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
        const baseline = result.cancelled || result.indeterminate
          ? "unknown"
          : result.passed
            ? "passed"
            : "failed";
        this.baselineResults.set(key, baseline);
        checks.push({
          packagePath,
          script,
          command,
          passed: result.passed && !result.cancelled,
          output: boundOutput(result.output),
          baseline,
        });
      }
    }
    const initialStatus = await this.runCommand("git status --short --untracked-files=all", signal);
    const head = await this.runCommand("git rev-parse HEAD", signal);
    if (head.passed && /^[a-f0-9]{40,64}$/i.test(head.output.trim())) {
      this.baselineHead = head.output.trim();
    }
    if (initialStatus.passed && !initialStatus.cancelled) {
      this.baselineWorkspaceKnown = true;
      for (const filePath of parseChangedFiles(initialStatus.output)) {
        const file = await this.sandbox.readFile(filePath);
        if (!file.ok) {
          this.baselineWorkspaceKnown = false;
          this.baselineFileHashes.clear();
          break;
        }
        this.baselineFileHashes.set(filePath, createHash("sha256").update(file.data).digest("hex"));
      }
    }
    const testFiles = await this.runCommand(
      "git ls-files --cached -- '*test*' '*spec*' 'test/**' 'tests/**'",
      signal,
    );
    if (testFiles.passed && !testFiles.cancelled) {
      this.baselineTestInventoryKnown = true;
      for (const filePath of [...new Set(testFiles.output.split(/\r?\n/).map((line) => line.trim()).filter(isTestSourcePath))]) {
        const file = await this.sandbox.readFile(filePath);
        if (!file.ok) {
          this.baselineTestInventoryKnown = false;
          this.baselineTestFiles.clear();
          break;
        }
        this.baselineTestFiles.set(filePath, file.data);
      }
    }
    return checks;
  }

  async inspectChangedFiles(
    signal?: AbortSignal,
    reportOnly = false,
  ): Promise<{ files: string[]; error?: string }> {
    const statusCommand = reportOnly
      ? "git status --porcelain=v1 --untracked-files=all"
      : "git status --short --untracked-files=all";
    const status = await this.runCommand(statusCommand, signal);
    if (!status.passed || status.cancelled) {
      return { files: [], error: `Unable to inspect workspace changes: ${status.output}` };
    }
    if (!this.baselineWorkspaceKnown) {
      return { files: [], error: "The task-start workspace baseline could not be captured safely" };
    }
    if (!this.baselineHead) {
      return { files: [], error: "The task-start Git revision could not be captured safely" };
    }

    const committedDiff = await this.runCommand(`git diff --name-only ${this.baselineHead}`, signal);
    if (!committedDiff.passed || committedDiff.cancelled) {
      return { files: [], error: `Unable to inspect committed workspace changes: ${committedDiff.output}` };
    }
    const taskChangedFiles: string[] = [];
    const candidates = new Set([
      ...parseChangedFiles(status.output),
      ...committedDiff.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ]);
    for (const filePath of candidates) {
      const baselineHash = this.baselineFileHashes.get(filePath);
      if (baselineHash === undefined) {
        taskChangedFiles.push(filePath);
        continue;
      }
      const file = await this.sandbox.readFile(filePath);
      if (!file.ok || createHash("sha256").update(file.data).digest("hex") !== baselineHash) {
        taskChangedFiles.push(filePath);
      }
    }
    return { files: taskChangedFiles };
  }

  async verify(signal?: AbortSignal): Promise<VerificationOutcome> {
    const inspection = await this.inspectChangedFiles(signal);
    if (inspection.error) {
      return {
        status: "unavailable",
        reason: inspection.error,
        changedFiles: [],
        skippedChecks: ["Repository checks were not run because workspace changes could not be inspected."],
      };
    }
    const changedFiles = inspection.files;
    if (changedFiles.length === 0) return { status: "no_changes", changedFiles: [] };
    const taskChangedFiles = changedFiles;
    const filePolicyChecks = await this.checkTaskPolicy(taskChangedFiles);
    if (filePolicyChecks.length > 0) {
      return {
        status: "failed",
        changedFiles: taskChangedFiles,
        checks: filePolicyChecks,
        skippedChecks: ["Repository scripts were not run because a safety/integrity policy check failed."],
      };
    }

    const locations = new Map<string, PackageManifest>();
    for (const file of taskChangedFiles) {
      const location = await this.findPackageManifest(file);
      if (!location) {
        return {
          status: "unavailable",
          reason: `Could not find a package.json for changed file ${file}`,
          changedFiles: taskChangedFiles,
          skippedChecks: ["Repository checks were not run because the changed file could not be assigned to a package."],
        };
      }
      locations.set(location.directory, location.manifest);
    }

    const policyChecks = await this.checkTaskPolicy(taskChangedFiles, locations);
    if (policyChecks.length > 0) {
      return {
        status: "failed",
        changedFiles: taskChangedFiles,
        checks: policyChecks,
        skippedChecks: ["Repository scripts were not run because a safety/integrity policy check failed."],
      };
    }

    const root = await this.readManifest(".");
    if (!root) {
      return {
        status: "unavailable",
        reason: "Could not read the repository root package.json to identify its package manager",
        changedFiles: taskChangedFiles,
        skippedChecks: ["Repository checks were not run because the package manager could not be identified."],
      };
    }
    const packageManager = await this.resolvePackageManager(root);
    if (!packageManager) {
      return {
        status: "unavailable",
        reason: root.packageManager
          ? `Unsupported package manager: ${root.packageManager}`
          : "Could not identify a supported package manager from the packageManager field or lockfiles",
        changedFiles: taskChangedFiles,
        skippedChecks: ["Repository checks were not run because the package manager could not be identified."],
      };
    }

    const checks: VerificationCheck[] = [];
    const skippedChecks: string[] = [];
    for (const [packagePath, manifest] of locations) {
    for (const script of VERIFICATION_SCRIPTS) {
      if (typeof manifest.scripts?.[script] !== "string") {
        skippedChecks.push(`${packagePath}: ${script} (not configured)`);
        continue;
      }
        const command = buildCommand(packageManager, packagePath, script);
        const result = await this.runCommand(command, signal);
        checks.push({
          packagePath,
          script,
          command,
          passed: result.passed && !result.cancelled,
          output: boundOutput(result.output),
          baseline: this.baselineResults.get(baselineKey(packagePath, script)) ?? "unknown",
        });
        if (result.indeterminate && !result.cancelled) {
          return {
            status: "unavailable",
            reason: `Could not reliably run verification command: ${command}`,
            changedFiles: taskChangedFiles,
            checks,
            skippedChecks,
          };
        }
        if (result.cancelled || signal?.aborted) {
          return {
            status: "failed",
            changedFiles: taskChangedFiles,
            checks,
            skippedChecks,
          };
        }
      }
    }

    if (checks.length === 0) {
      return {
        status: "unavailable",
        reason: "No test, typecheck, lint, or build script is configured for the changed packages",
        changedFiles: taskChangedFiles,
        checks,
        skippedChecks,
      };
    }

    return {
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      changedFiles: taskChangedFiles,
      checks,
      skippedChecks,
    };
  }

  private async checkTaskPolicy(
    changedFiles: string[],
    locations?: Map<string, PackageManifest>,
  ): Promise<VerificationCheck[]> {
    const checks: VerificationCheck[] = [];
    for (const filePath of changedFiles) {
      const normalizedPath = filePath.replaceAll("\\", "/");
      if (normalizedPath.startsWith("/") || normalizedPath.split("/").includes("..")) {
        checks.push(policyCheck(filePath, "allowed-path", "Changed path is outside the workspace boundary."));
        continue;
      }
      if (/(^|\/)\.git(\/|$)/i.test(normalizedPath) || /(^|\/)\.cutebots-askpass-/i.test(normalizedPath)) {
        checks.push(policyCheck(filePath, "allowed-path", "Git metadata and temporary credential helper files are not editable task outputs."));
        continue;
      }
      if (isCredentialFilePath(normalizedPath)) {
        checks.push(policyCheck(filePath, "secret-scan", "Credential/private-key files are not allowed in task changes."));
        continue;
      }
      if (isVerificationControlPath(normalizedPath)) {
        checks.push(policyCheck(filePath, "verification-integrity", "Test-runner and CI verification configuration requires manual review and cannot be changed by an auto-verified task."));
        continue;
      }

      const file = await this.sandbox.readFile(filePath);
      if (file.ok) {
        if (file.data.length > 2_000_000) {
          checks.push(policyCheck(filePath, "secret-scan", "Secret scan was skipped because the changed file exceeds the 2 MB safety limit."));
        } else {
          const secretKinds = findSecretKinds(file.data);
          for (const kind of secretKinds) {
            checks.push(policyCheck(filePath, "secret-scan", `Potential ${kind} detected; secret values are not included in this report.`));
          }
        }
      }

      if (!isTestSourcePath(filePath)) continue;
      const baseline = this.baselineTestFiles.get(filePath);
      if (baseline === undefined && !this.baselineTestInventoryKnown) {
        checks.push(policyCheck(filePath, "test-integrity", "The task-start test baseline is unavailable; changed tests cannot be verified safely."));
        continue;
      }
      if (!file.ok) {
        if (baseline && countTestCases(baseline) > 0) {
          checks.push(policyCheck(filePath, "test-integrity", "A test source file with existing tests was removed or could not be read."));
        }
        continue;
      }
      if (!baseline) {
        if (countTestIntegritySignals(file.data).disabled > 0) {
          checks.push(policyCheck(filePath, "test-integrity", "New test files may not contain skipped, todo, or focused test declarations."));
        }
        continue;
      }
      const baselineCounts = countTestIntegritySignals(baseline);
      const currentCounts = countTestIntegritySignals(file.data);
      if (currentCounts.tests < baselineCounts.tests || !containsBaselineTestNames(baseline, file.data)) {
        checks.push(policyCheck(filePath, "test-integrity", "Existing test declarations were removed or renamed; restore or replace the existing coverage before verification."));
      }
      if (currentCounts.assertions < baselineCounts.assertions) {
        checks.push(policyCheck(filePath, "test-integrity", "Test assertions were removed; restore or replace the existing coverage before verification."));
      }
      if (currentCounts.disabled > baselineCounts.disabled) {
        checks.push(policyCheck(filePath, "test-integrity", "New skipped, todo, or focused test declarations are not allowed."));
      }
    }

    if (!locations) return checks;
    for (const [packagePath, manifest] of locations) {
      const manifestPath = packagePath === "." ? "package.json" : `${packagePath}/package.json`;
      if (!changedFiles.includes(manifestPath)) continue;
      const baselineScripts = this.baselinePackageScripts.get(packagePath);
      if (!baselineScripts) {
        checks.push(policyCheck(manifestPath, "test-integrity", "Verification scripts have no trusted task-start baseline."));
        continue;
      }
      for (const script of VERIFICATION_SCRIPTS) {
        if (manifest.scripts?.[script] !== baselineScripts[script]) {
          checks.push(policyCheck(manifestPath, "test-integrity", `The ${script} verification script changed during the task.`));
        }
      }
      if (manifest.packageManager !== this.baselinePackageManagers.get(packagePath)) {
        checks.push(policyCheck(manifestPath, "test-integrity", "The package manager declaration changed during the task."));
      }
    }
    return checks;
  }

  private async findPackageManifest(filePath: string): Promise<PackageLocation | undefined> {
    const parts = filePath.split("/").filter(Boolean);
    parts.pop();
    for (let length = parts.length; length >= 0; length -= 1) {
      const directory = parts.slice(0, length).join("/") || ".";
      const manifest = await this.readManifest(directory);
      if (manifest) return { directory, manifest };
    }
    return undefined;
  }

  private async readManifest(directory: string): Promise<PackageManifest | undefined> {
    const filePath = directory === "." ? "package.json" : `${directory}/package.json`;
    const result = await this.sandbox.readFile(filePath);
    if (!result.ok) return undefined;
    try {
      const manifest: unknown = JSON.parse(result.data);
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
      const record = manifest as Record<string, unknown>;
      const scripts = record.scripts;
      return {
        ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
        ...(typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
          ? { scripts: scripts as Record<string, unknown> }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async resolvePackageManager(
    manifest: PackageManifest,
  ): Promise<"npm" | "pnpm" | "yarn" | "bun" | undefined> {
    if (manifest.packageManager) return getPackageManager(manifest);
    const lockfiles: Array<{ path: string; manager: "npm" | "pnpm" | "yarn" | "bun" }> = [
      { path: "pnpm-lock.yaml", manager: "pnpm" },
      { path: "yarn.lock", manager: "yarn" },
      { path: "bun.lock", manager: "bun" },
      { path: "bun.lockb", manager: "bun" },
      { path: "package-lock.json", manager: "npm" },
      { path: "npm-shrinkwrap.json", manager: "npm" },
    ];
    const detected = new Set<"npm" | "pnpm" | "yarn" | "bun">();
    for (const lockfile of lockfiles) {
      if ((await this.sandbox.readFile(lockfile.path)).ok) detected.add(lockfile.manager);
    }
    return detected.size === 1 ? [...detected][0] : undefined;
  }

  private async runCommand(
    command: string,
    signal?: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    if (signal?.aborted) return { passed: false, output: "Task was cancelled", cancelled: true, indeterminate: true };
    let result: Result<CommandJobSnapshot>;
    try {
      result = await this.sandbox.runCommand(command, {
        foregroundTimeoutMs: Math.min(COMMAND_START_TIMEOUT_MS, timeoutMs),
        pollIntervalMs: COMMAND_POLL_INTERVAL_MS,
        signal,
      });
    } catch (error) {
      return {
        passed: false,
        output: error instanceof Error ? error.message : "Sandbox command failed",
        cancelled: Boolean(signal?.aborted),
        indeterminate: true,
      };
    }
    if (!result.ok) {
      return {
        passed: false,
        output: result.error,
        cancelled: Boolean(signal?.aborted),
        indeterminate: true,
      };
    }

    let snapshot = result.data;
    let output = snapshot.output;
    const startedAt = Date.now();
    while (snapshot.status === "running") {
      if (signal?.aborted) {
        const cancelled = await this.sandbox.cancelCommand(snapshot.jobId);
        return {
          passed: false,
          output: `${output}\nVerification cancelled${cancelled.ok ? "" : `; command cancellation failed: ${cancelled.error}`}`,
          cancelled: true,
          indeterminate: true,
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const cancelled = await this.sandbox.cancelCommand(snapshot.jobId);
        return {
          passed: false,
          output: [
            output,
            `Verification command exceeded its ${Math.ceil(timeoutMs / 60_000)}-minute limit`,
            cancelled.ok ? "Command cancelled." : `Command cancellation failed: ${cancelled.error}`,
          ].filter(Boolean).join("\n"),
          cancelled: false,
          indeterminate: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));
      const polled = await this.sandbox.pollCommand(snapshot.jobId, snapshot.nextOffset);
      if (!polled.ok) return { passed: false, output: polled.error, cancelled: false, indeterminate: true };
      snapshot = polled.data;
      output += snapshot.output;
    }

    const passed = snapshot.status === "completed" && snapshot.exitCode === 0;
    return {
      passed,
      output: [
        output,
        snapshot.outputTruncated ? "Verification output was truncated at the sandbox limit." : "",
        passed ? "" : `Command status: ${snapshot.status}; exit code: ${snapshot.exitCode ?? "unknown"}`,
      ].filter(Boolean).join("\n"),
      cancelled: snapshot.status === "cancelled" || Boolean(signal?.aborted),
      indeterminate:
        snapshot.status === "timed_out" ||
        snapshot.status === "cancelled" ||
        (snapshot.status === "failed" && snapshot.exitCode === 127),
    };
  }
}

function parseChangedFiles(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let filePath = line.slice(3).trim();
    const renameSeparator = filePath.lastIndexOf(" -> ");
    if (renameSeparator >= 0) filePath = filePath.slice(renameSeparator + 4);
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    if (filePath && !filePath.startsWith("../") && filePath !== "..") paths.add(filePath);
  }
  return [...paths];
}

function policyCheck(filePath: string, rule: string, output: string): VerificationCheck {
  return {
    packagePath: ".",
    script: rule,
    command: `policy:${rule} ${filePath}`,
    passed: false,
    output,
    baseline: "unknown",
  };
}

function isCredentialFilePath(filePath: string): boolean {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^\.env(?:$|\.(?!example$|sample$|template$))/.test(name)) return true;
  return /^(?:id_rsa|id_ed25519|server\.key|private\.key)$/.test(name) ||
    /\.(?:pem|p12|pfx|key)$/i.test(name);
}

function isVerificationControlPath(filePath: string): boolean {
  return /(^|\/)\.github\/workflows\//i.test(filePath) ||
    /(^|\/)(?:vitest|jest|playwright|mocha|ava|tap)\.config\.[^/]+$/i.test(filePath) ||
    /(^|\/)(?:turbo\.json|\.npmrc|\.yarnrc(?:\.yml)?|pnpm-workspace\.yaml)$/i.test(filePath);
}

function findSecretKinds(content: string): string[] {
  const kinds = new Set<string>();
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) kinds.add("private-key material");
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(content)) kinds.add("GitHub token");
  if (/\bAKIA[0-9A-Z]{16}\b/.test(content)) kinds.add("AWS access key");
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(content)) kinds.add("bearer token");
  if (/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["']?(?!\$\{|process\.env|your[_ -]|example|placeholder|changeme|<)[A-Za-z0-9_./+=-]{12,}/i.test(content)) {
    kinds.add("credential assignment");
  }
  if (/\/\/[^:/\s]+:[^@\s]{12,}@/.test(content)) kinds.add("credential-bearing URL");
  return [...kinds];
}

function isTestSourcePath(filePath: string): boolean {
  return /(?:^|\/)(?:__tests__|test|tests)\/.*\.(?:[cm]?[jt]sx?)$/i.test(filePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function countTestCases(source: string): number {
  return (source.match(/\b(?:test|it)\s*(?:\.\s*(?:skip|only|todo)\s*)?\(/g) ?? []).length;
}

function countTestIntegritySignals(source: string): { tests: number; assertions: number; disabled: number } {
  return {
    tests: countTestCases(source),
    assertions: (source.match(/\bassert\.[A-Za-z_$][\w$]*\s*\(|\bexpect\s*\(/g) ?? []).length,
    disabled: (source.match(/\b(?:test|it|describe|suite)\s*\.\s*(?:skip|only|todo)\s*\(/g) ?? []).length,
  };
}

function containsBaselineTestNames(baseline: string, current: string): boolean {
  const currentNames = countTestNames(current);
  for (const [name, count] of countTestNames(baseline)) {
    if ((currentNames.get(name) ?? 0) < count) return false;
  }
  return true;
}

function countTestNames(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  const titlePattern = /\b(?:test|it)\s*\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of source.matchAll(titlePattern)) {
    const name = match[2];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function getPackageManager(manifest: PackageManifest): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  if (!manifest.packageManager) return undefined;
  const name = manifest.packageManager.split("@", 1)[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

function baselineKey(packagePath: string, script: string): string {
  return `${packagePath}\0${script}`;
}

function buildCommand(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  packagePath: string,
  script: string,
): string {
  const directory = quoteShellArgument(packagePath);
  if (manager === "npm") return `npm --prefix ${directory} run ${script}`;
  if (manager === "pnpm") return `pnpm --dir ${directory} run ${script}`;
  if (manager === "yarn") return `yarn --cwd ${directory} ${script}`;
  return `bun --cwd ${directory} run ${script}`;
}

function quoteShellArgument(value: string): string {
  if (!value || value.startsWith("/") || value.split("/").includes("..") || value.includes("\0")) {
    throw new Error(`Unsafe package path for verification: ${value}`);
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function boundOutput(output: string): string {
  if (output.length <= MAX_REPORTED_OUTPUT_CHARS) return output;
  return `[Earlier verification output omitted]\n${output.slice(-MAX_REPORTED_OUTPUT_CHARS)}`;
}
