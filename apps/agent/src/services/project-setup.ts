import type { ContainerManager, Sandbox, SandboxProfile } from "@workspace/core";
import { RepositoryProfileDetector, GitTool } from "@workspace/core";
import type { PrismaClient, SecretVault } from "@workspace/db";
import { redactTextSecrets } from "@workspace/core";

const SETUP_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_SETUP_OUTPUT_CHARS = 8_000;

interface SetupProject {
  id: string;
  repo_url: string;
  sandbox_type: string;
  clone_credential: string | null;
}

interface PackageManifest {
  packageManager?: string;
  scripts?: Record<string, unknown>;
}

interface PackageInstall {
  directory: string;
  manager: "npm" | "pnpm" | "yarn" | "bun";
  lockfile?: string;
  hasSetupScript: boolean;
}

export class ProjectSetupError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "ProjectSetupError";
  }
}

export class ProjectSetupService {
  private readonly profiles = new RepositoryProfileDetector();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly containers: ContainerManager,
    private readonly vaultFactory: () => SecretVault,
  ) {}

  async prepare(
    project: SetupProject,
    log: (message: string) => Promise<void>,
  ): Promise<string> {
    const profile = toSandboxProfile(project.sandbox_type);
    const sandbox = await this.getSandbox(project.id, profile);
    const cloneCredential = project.clone_credential
      ? this.vaultFactory().decrypt(project.clone_credential)
      : undefined;
    const git = new GitTool({
      repositoryUrl: project.repo_url,
      taskId: `setup-${project.id}`,
      readOnlyCloneCredential: cloneCredential,
    });
    await log("Cloning repository.");
    const cloned = await git.cloneRepository(sandbox);
    if (!cloned.success) throw setupError(`Repository clone failed: ${cloned.output}`);

    const repositoryProfile = await this.profiles.detect(project.id, sandbox);
    for (const warning of repositoryProfile.warnings) {
      await log(`Repository detection warning: ${warning}`);
    }
    const files = await this.listRepositoryFiles(sandbox);
    const unsupported = findUnsupportedRuntimeSignals(files);
    if (unsupported.length > 0) {
      throw new ProjectSetupError(
        `Unsupported setup: automatic provisioning currently supports static projects and Node.js projects only. Detected: ${unsupported.join(", ")}.`,
        false,
      );
    }

    const packagePaths = files
      .filter((filePath) => filePath === "package.json" || filePath.endsWith("/package.json"))
      .sort((left, right) => left.localeCompare(right));
    const nodeRequired = requiresNode(files, packagePaths);
    if (profile === "minimal" && nodeRequired) {
      throw new ProjectSetupError(
        "This repository needs Node.js, but the selected No Node.js sandbox does not include it. Recreate the project with the Node.js sandbox selected.",
        false,
      );
    }

    if (packagePaths.length === 0) {
      await log(nodeRequired
        ? "Node.js runtime selected; no package manifest or dependency install was found."
        : "Static project detected; no runtime or package installation is required.");
    } else {
      const installs = await this.findPackageInstalls(sandbox, files, packagePaths);
      for (const install of installs) {
        const command = packageInstallCommand(install);
        await this.runSetupCommand(sandbox, install.directory, command, log);
        if (install.hasSetupScript) {
          await this.runSetupCommand(sandbox, install.directory, `${install.manager} run setup`, log);
        }
      }
    }

    for (const scriptPath of ["setup.sh", "scripts/setup.sh"]) {
      if (files.includes(scriptPath)) {
        await this.runSetupCommand(sandbox, ".", `bash ${shellQuote(`./${scriptPath}`)}`, log);
      }
    }

    return packagePaths.length > 0
      ? `Node.js (${detectPackageManagerLabel(files)})`
      : nodeRequired
        ? "Node.js runtime"
        : "Static (no Node.js)";
  }

  private async getSandbox(projectId: string, profile: SandboxProfile): Promise<Sandbox> {
    let sandbox = this.containers.get(projectId);
    if (!sandbox.ok) {
      const recovered = await this.containers.recover(projectId, profile);
      if (!recovered.ok) throw new Error(`Unable to recover project sandbox: ${recovered.error}`);
      sandbox = this.containers.get(projectId);
    }
    if (!sandbox.ok) throw new Error(sandbox.error);
    return sandbox.data;
  }

  private async listRepositoryFiles(sandbox: Sandbox): Promise<string[]> {
    const listed = await sandbox.listFiles(".");
    if (!listed.ok) throw new Error(`Unable to inspect repository files: ${listed.error}`);
    return [...new Set(listed.data.split(/\r?\n/)
      .map((filePath) => filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/workspace\//, ""))
      .filter((filePath) => filePath && filePath !== "/workspace"))];
  }

  private async findPackageInstalls(
    sandbox: Sandbox,
    files: string[],
    packagePaths: string[],
  ): Promise<PackageInstall[]> {
    const roots = packagePaths.includes("package.json")
      ? ["."]
      : [...new Set(packagePaths.map((filePath) => filePath.slice(0, -"/package.json".length)))];
    const installs: PackageInstall[] = [];
    for (const directory of roots) {
      const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
      const manifestFile = await sandbox.readFile(manifestPath);
      if (!manifestFile.ok) throw new Error(`Unable to read ${manifestPath}: ${manifestFile.error}`);
      const manifest = parseManifest(manifestFile.data, manifestPath);
      const lockfiles = packageLockfiles(files, directory);
      const manager = resolvePackageManager(manifest.packageManager, lockfiles, manifestPath);
      installs.push({
        directory,
        manager,
        lockfile: lockfiles.find((lockfile) => lockfile.manager === manager)?.path,
        hasSetupScript: typeof manifest.scripts?.setup === "string",
      });
    }
    return installs;
  }

  private async runSetupCommand(
    sandbox: Sandbox,
    directory: string,
    command: string,
    log: (message: string) => Promise<void>,
  ): Promise<void> {
    const workingDirectory = directory === "." ? "/workspace" : `/workspace/${directory}`;
    await log(`Running setup command: (cd ${shellQuote(workingDirectory)} && ${command})`);
    const result = await sandbox.runCommand(
      `cd ${shellQuote(workingDirectory)} && ${command}`,
      { foregroundTimeoutMs: SETUP_COMMAND_TIMEOUT_MS },
    );
    if (!result.ok) throw setupError(result.error);
    const snapshot = result.data;
    if (snapshot.output) {
      await log(redactTextSecrets(snapshot.output).slice(-MAX_SETUP_OUTPUT_CHARS));
    }
    if (snapshot.status !== "completed" || snapshot.exitCode !== 0) {
      const output = redactTextSecrets(snapshot.output).slice(-MAX_SETUP_OUTPUT_CHARS);
      throw setupError(
        `Setup command failed (${snapshot.status}, exit ${snapshot.exitCode ?? "unknown"}): ${command}${output ? `\n${output}` : ""}`,
      );
    }
    await log(`Setup command succeeded: ${command}`);
  }
}

function toSandboxProfile(value: string): SandboxProfile {
  if (value === "node" || value === "minimal") return value;
  throw new ProjectSetupError(`Unknown sandbox selection: ${value}`, false);
}

function requiresNode(files: string[], packagePaths: string[]): boolean {
  if (packagePaths.length > 0) return true;
  if (files.some((filePath) =>
    /(^|\/)(?:\.nvmrc|\.node-version|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(filePath) ||
    /(^|\/)(?:next|vite|webpack|rollup|tsconfig)\.config\.[cm]?[jt]s$/.test(filePath),
  )) return true;
  const hasHtml = files.some((filePath) => /\.html?$/i.test(filePath));
  return !hasHtml && files.some((filePath) => /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(filePath));
}

function findUnsupportedRuntimeSignals(files: string[]): string[] {
  const signals: Array<[string, RegExp]> = [
    ["Python", /(?:^|\/)(?:requirements\.txt|pyproject\.toml|Pipfile|Pipfile\.lock)$/i],
    ["Python", /\.py$/i],
    ["Go", /(?:^|\/)(?:go\.mod|go\.sum)$/i],
    ["Go", /\.go$/i],
    ["Rust", /(?:^|\/)(?:Cargo\.toml|Cargo\.lock)$/i],
    ["Rust", /\.rs$/i],
    ["Java", /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/i],
    ["Java", /\.(?:java|kt)$/i],
    ["Ruby", /(?:^|\/)(?:Gemfile|Gemfile\.lock)$/i],
    ["Ruby", /\.rb$/i],
    ["PHP", /(?:^|\/)(?:composer\.json|composer\.lock)$/i],
    ["PHP", /\.php$/i],
    [".NET", /\.(?:csproj|sln|fsproj)$/i],
  ];
  return [...new Set(files.flatMap((filePath) =>
    signals.filter(([, matcher]) => matcher.test(filePath)).map(([runtime]) => runtime),
  ))];
}

function parseManifest(content: string, path: string): PackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ProjectSetupError(
      `Invalid ${path}: ${error instanceof Error ? error.message : "malformed JSON"}`,
      false,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectSetupError(`Invalid ${path}: expected a JSON object.`, false);
  }
  const record = parsed as Record<string, unknown>;
  const scripts = typeof record.scripts === "object" && record.scripts !== null && !Array.isArray(record.scripts)
    ? record.scripts as Record<string, unknown>
    : undefined;
  return {
    ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
    ...(scripts ? { scripts } : {}),
  };
}

function packageLockfiles(
  files: string[],
  directory: string,
): Array<{ manager: PackageInstall["manager"]; path: string }> {
  const names: Array<[PackageInstall["manager"], string]> = [
    ["npm", "package-lock.json"],
    ["npm", "npm-shrinkwrap.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ];
  return names.flatMap(([manager, name]) => {
    const path = directory === "." ? name : `${directory}/${name}`;
    return files.includes(path) ? [{ manager, path }] : [];
  });
}

function resolvePackageManager(
  declared: string | undefined,
  lockfiles: Array<{ manager: PackageInstall["manager"]; path: string }>,
  manifestPath: string,
): PackageInstall["manager"] {
  const declaredManager = declared?.split("@", 1)[0];
  if (declaredManager && !isPackageManager(declaredManager)) {
    throw new ProjectSetupError(
      `Unsupported package manager "${declaredManager}" declared in ${manifestPath}. Supported: npm, pnpm, yarn, bun.`,
      false,
    );
  }
  const lockManagers = [...new Set(lockfiles.map(({ manager }) => manager))];
  if (lockManagers.length > 1) {
    throw new ProjectSetupError(
      `Conflicting lockfiles for ${manifestPath}: ${lockfiles.map(({ path }) => path).join(", ")}.`,
      false,
    );
  }
  const lockManager = lockManagers[0];
  if (declaredManager && lockManager && declaredManager !== lockManager) {
    throw new ProjectSetupError(
      `${manifestPath} declares ${declaredManager}, but its lockfile belongs to ${lockManager}.`,
      false,
    );
  }
  if (declaredManager && isPackageManager(declaredManager)) return declaredManager;
  return lockManager ?? "npm";
}

function isPackageManager(value: string): value is PackageInstall["manager"] {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function packageInstallCommand(install: PackageInstall): string {
  const lockArgument = install.lockfile
    ? install.manager === "npm"
      ? "ci"
      : install.manager === "yarn"
        ? "install --frozen-lockfile"
        : "install --frozen-lockfile"
    : "install";
  return install.manager === "npm"
    ? `npm ${lockArgument}`
    : `${install.manager} ${lockArgument}`;
}

function detectPackageManagerLabel(files: string[]): string {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return "npm";
}

function setupError(message: string): ProjectSetupError {
  return new ProjectSetupError(message, isTransientSetupFailure(message));
}

function isTransientSetupFailure(message: string): boolean {
  return /timed out|timeout|temporary failure|could not resolve|name resolution|network is unreachable|connection (?:reset|refused|timed out)|ECONNRESET|ETIMEDOUT|\b(?:429|502|503|504)\b/i.test(message);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
