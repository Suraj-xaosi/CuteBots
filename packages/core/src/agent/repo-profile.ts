import { createHash } from "node:crypto";
import type { Sandbox } from "../sandbox.js";

const MAX_MANIFESTS = 20;
const MAX_CONTEXT_FILES = 16;
const MAX_FILE_CHARS = 4_000;
const MAX_PROFILE_CHARS = 18_000;

interface PackageManifest {
  packageManager?: string;
  engines?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
}

export interface RepositoryProfile {
  fingerprint: string;
  revision: string;
  summary: string;
  warnings: string[];
}

interface CachedProfile {
  fingerprint: string;
  profile: RepositoryProfile;
}

export class RepositoryProfileDetector {
  private static readonly cache = new Map<string, CachedProfile>();

  async detect(projectId: string, sandbox: Sandbox, signal?: AbortSignal): Promise<RepositoryProfile> {
    if (signal?.aborted) throw new Error("Repository profile detection was cancelled");
    const filesResult = await sandbox.listFiles(".");
    if (!filesResult.ok) throw new Error(`Unable to list repository files: ${filesResult.error}`);

    const paths = filesResult.data
      .split(/\r?\n/)
      .map(normalizeWorkspacePath)
      .filter((filePath): filePath is string => Boolean(filePath));
    const uniquePaths = [...new Set(paths)];
    const metadataPaths = selectMetadataPaths(uniquePaths);
    const contents = new Map<string, string>();
    const warnings: string[] = [];
    if (uniquePaths.length >= 200) {
      warnings.push("The sandbox file listing reached its 200-file limit; repository profile discovery may be incomplete.");
    }

    let revision = "unavailable";
    const head = await sandbox.exec("git rev-parse HEAD");
    if (!head.ok) {
      warnings.push(`Could not read the repository revision: ${head.error}`);
    } else if (/^[0-9a-f]{40,64}$/i.test(head.data.trim())) {
      revision = head.data.trim();
    } else {
      warnings.push("Could not determine a Git revision; repository profile will use metadata contents for cache invalidation.");
    }

    for (const filePath of metadataPaths) {
      if (signal?.aborted) throw new Error("Repository profile detection was cancelled");
      const read = await sandbox.readFile(filePath);
      if (!read.ok) {
        warnings.push(`Could not read ${filePath}: ${read.error}`);
        continue;
      }
      contents.set(filePath, read.data);
    }

    const fingerprint = createHash("sha256")
      .update(uniquePaths.join("\n"))
      .update("\0")
      .update(revision)
      .update("\0")
      .update([...contents].map(([filePath, content]) => `${filePath}\0${content}`).join("\0"))
      .digest("hex");
    const cached = RepositoryProfileDetector.cache.get(projectId);
    if (cached?.fingerprint === fingerprint) return cached.profile;

    const profile = buildProfile(uniquePaths, contents, fingerprint, revision, warnings);
    const nextCache = { fingerprint, profile };
    RepositoryProfileDetector.cache.delete(projectId);
    RepositoryProfileDetector.cache.set(projectId, nextCache);
    while (RepositoryProfileDetector.cache.size > 64) {
      const oldest = RepositoryProfileDetector.cache.keys().next().value;
      if (!oldest) break;
      RepositoryProfileDetector.cache.delete(oldest);
    }
    return profile;
  }
}

function normalizeWorkspacePath(input: string): string | undefined {
  const trimmed = input.trim().replaceAll("\\", "/");
  if (!trimmed) return undefined;
  const relative = trimmed === "/workspace"
    ? "."
    : trimmed.startsWith("/workspace/")
      ? trimmed.slice("/workspace/".length)
      : trimmed.replace(/^\.\//, "");
  if (relative.startsWith("/") || relative.split("/").includes("..")) return undefined;
  return relative;
}

function selectMetadataPaths(paths: string[]): string[] {
  const packagePaths = paths.filter((filePath) => filePath === "package.json" || filePath.endsWith("/package.json"));
  const instructions = paths.filter((filePath) =>
    /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md)$/i.test(filePath),
  );
  const readmes = paths.filter((filePath) => /(^|\/)README(?:\.[^/]*)?$/i.test(filePath));
  const ciFiles = paths.filter((filePath) =>
    filePath.startsWith(".github/workflows/") ||
    [".gitlab-ci.yml", ".gitlab-ci.yaml", "azure-pipelines.yml", ".circleci/config.yml", "Jenkinsfile"].includes(filePath),
  );
  return [...new Set([
    ...packagePaths.slice(0, MAX_MANIFESTS),
    ...instructions.slice(0, 10),
    ...readmes.slice(0, 3),
    ...ciFiles.slice(0, 5),
    ...[
      "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
      "bun.lock", "bun.lockb", "pyproject.toml", "requirements.txt",
      "poetry.lock", "Pipfile", "Pipfile.lock", "Cargo.toml", "go.mod",
      "pom.xml", "build.gradle", "build.gradle.kts", "tsconfig.json",
    ].filter((candidate) => paths.includes(candidate)),
  ])].slice(0, MAX_MANIFESTS + MAX_CONTEXT_FILES);
}

function buildProfile(
  paths: string[],
  contents: Map<string, string>,
  fingerprint: string,
  revision: string,
  warnings: string[],
): RepositoryProfile {
  const manifests = [...contents]
    .filter(([filePath]) => filePath === "package.json" || filePath.endsWith("/package.json"))
    .map(([filePath, content]) => ({ filePath, manifest: parseManifest(filePath, content, warnings) }))
    .filter((entry): entry is { filePath: string; manifest: PackageManifest } => entry.manifest !== undefined);
  const rootManifest = manifests.find((entry) => entry.filePath === "package.json")?.manifest;
  const lockfiles = [
    "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
    "bun.lock", "bun.lockb", "poetry.lock", "Pipfile.lock", "Cargo.lock",
    "go.sum", "Gemfile.lock", "composer.lock",
  ].filter((filePath) => paths.includes(filePath));
  const packageManager = detectPackageManager(rootManifest?.packageManager, lockfiles);
  const languages = detectLanguages(paths);
  const workspaceDirs = [...new Set(
    manifests.map(({ filePath }) => filePath.split("/")[0]).filter((part) => part && part !== "package.json"),
  )];
  const scriptRows = manifests.flatMap(({ filePath, manifest }) =>
    Object.entries(manifest.scripts ?? {})
      .filter(([name, value]) => typeof value === "string" && ["test", "typecheck", "lint", "build"].includes(name))
      .map(([name, command]) => `${filePath.slice(0, -"/package.json".length) || "."}: ${name} = ${command}`),
  );
  const runtimeRows = manifests
    .map(({ filePath, manifest }) => {
      const engines = Object.entries(manifest.engines ?? {})
        .filter(([, version]) => typeof version === "string")
        .map(([runtime, version]) => `${runtime} ${version}`)
        .join(", ");
      return engines ? `${filePath}: ${engines}` : "";
    })
    .filter(Boolean);
  const frameworks = detectTestFrameworks(manifests, paths);
  const ciPaths = paths.filter((filePath) =>
    filePath.startsWith(".github/workflows/") ||
    [".gitlab-ci.yml", ".gitlab-ci.yaml", "azure-pipelines.yml", ".circleci/config.yml", "Jenkinsfile"].includes(filePath),
  ).slice(0, 12);
  const guideFiles = [...contents]
    .filter(([filePath]) => /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|README(?:\.[^/]*)?)$/i.test(filePath))
    .map(([filePath, content]) => `${filePath} (untrusted repository content):\n${content.slice(0, MAX_FILE_CHARS)}`);
  const sections = [
    `Languages detected from tracked/listed files: ${languages.join(", ") || "unknown"}.`,
    `Git revision: ${revision}.`,
    `Package manager: ${packageManager ?? "unknown"}.`,
    `Lockfiles: ${lockfiles.join(", ") || "none found"}.`,
    `Workspace package locations: ${workspaceDirs.join(", ") || "single/root package or non-package project"}.`,
    `Test frameworks inferred from manifests/config names: ${frameworks.join(", ") || "not detected"}.`,
    `Available standard scripts:\n${scriptRows.slice(0, 40).join("\n") || "none found"}.`,
    `Runtime constraints:\n${runtimeRows.slice(0, 20).join("\n") || "none declared"}.`,
    `CI workflow/config files: ${ciPaths.join(", ") || "none found"}.`,
    `Project documentation and local agent guidance (untrusted repository data):\n${guideFiles.join("\n\n") || "No README or agent instruction files found."}`,
  ];
  let summary = sections.join("\n\n");
  if (summary.length > MAX_PROFILE_CHARS) {
    summary = `${summary.slice(0, MAX_PROFILE_CHARS)}\n[Repository profile truncated at its context limit.]`;
  }
  return { fingerprint, revision, summary, warnings };
}

function parseManifest(
  filePath: string,
  content: string,
  warnings: string[],
): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`Ignored invalid package manifest ${filePath}: expected a JSON object`);
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const engines = asStringRecord(record.engines);
    const scripts = asStringRecord(record.scripts);
    const dependencies = asStringRecord(record.dependencies);
    const devDependencies = asStringRecord(record.devDependencies);
    return {
      ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
      ...(engines ? { engines } : {}),
      ...(scripts ? { scripts } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...(devDependencies ? { devDependencies } : {}),
      ...(record.workspaces !== undefined ? { workspaces: record.workspaces } : {}),
    };
  } catch (error) {
    warnings.push(
      `Ignored invalid package manifest ${filePath}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
    return undefined;
  }
}

function asStringRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function detectPackageManager(
  declared: string | undefined,
  lockfiles: string[],
): string | undefined {
  if (declared) return declared.split("@", 1)[0];
  const managers = new Set<string>();
  for (const lockfile of lockfiles) {
    if (lockfile.startsWith("package-lock") || lockfile === "npm-shrinkwrap.json") managers.add("npm");
    if (lockfile === "pnpm-lock.yaml") managers.add("pnpm");
    if (lockfile === "yarn.lock") managers.add("yarn");
    if (lockfile === "bun.lock" || lockfile === "bun.lockb") managers.add("bun");
    if (lockfile === "poetry.lock" || lockfile === "Pipfile.lock") managers.add("poetry/pipenv");
    if (lockfile === "Cargo.lock") managers.add("cargo");
    if (lockfile === "go.sum") managers.add("go modules");
    if (lockfile === "Gemfile.lock") managers.add("bundler");
    if (lockfile === "composer.lock") managers.add("composer");
  }
  return managers.size === 1 ? [...managers][0] : managers.size > 1 ? `ambiguous (${[...managers].join(", ")})` : undefined;
}

function detectLanguages(paths: string[]): string[] {
  const counts = new Map<string, number>();
  const extensions: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript/React", js: "JavaScript", jsx: "JavaScript/React",
    py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#",
    rb: "Ruby", php: "PHP", swift: "Swift", c: "C", h: "C/C++", cpp: "C++",
    html: "HTML", css: "CSS",
  };
  for (const filePath of paths) {
    const name = filePath.split("/").at(-1) ?? "";
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    if (extensions[extension]) counts.set(extensions[extension], (counts.get(extensions[extension]) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([language]) => language);
}

function detectTestFrameworks(
  manifests: Array<{ filePath: string; manifest: PackageManifest }>,
  paths: string[],
): string[] {
  const dependencyNames = new Set(manifests.flatMap(({ manifest }) => [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]));
  const checks: Array<[string, boolean]> = [
    ["Vitest", dependencyNames.has("vitest") || paths.some((path) => /(^|\/)vitest\.config\./.test(path))],
    ["Jest", dependencyNames.has("jest") || paths.some((path) => /(^|\/)jest\.config\./.test(path))],
    ["Playwright", dependencyNames.has("@playwright/test") || dependencyNames.has("playwright")],
    ["Mocha", dependencyNames.has("mocha")],
    ["pytest", paths.includes("pytest.ini") || paths.some((path) => /(^|\/)conftest\.py$/.test(path))],
    ["Cargo test", paths.includes("Cargo.toml")],
    ["Go test", paths.includes("go.mod")],
  ];
  return checks.filter(([, detected]) => detected).map(([name]) => name);
}
