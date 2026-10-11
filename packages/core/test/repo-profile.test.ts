import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, type Result } from "@workspace/types";
import { RepositoryProfileDetector } from "../src/agent/repo-profile.js";
import { Sandbox } from "../src/sandbox.js";

class ProfileSandbox extends Sandbox {
  readonly files = new Map<string, string>();
  listOutput = "";

  constructor() {
    super("repo-profile-test");
  }

  override async listFiles(): Promise<Result<string>> {
    return { ok: true, data: this.listOutput };
  }

  override async exec(): Promise<Result<string>> {
    return { ok: true, data: "a".repeat(40) };
  }

  override async readFile(filePath: string): Promise<Result<string>> {
    const contents = this.files.get(filePath);
    return contents === undefined
      ? { ok: false, error: `missing ${filePath}`, code: ErrorCode.CONTAINER_EXEC_FAILED }
      : { ok: true, data: contents };
  }
}

test("repository profile detects package manager, languages, commands, CI, and trusted-boundary docs", async () => {
  const sandbox = new ProfileSandbox();
  sandbox.listOutput = [
    "package.json",
    "package-lock.json",
    "src/index.ts",
    "tests/index.test.ts",
    ".github/workflows/ci.yml",
    "README.md",
    "AGENTS.md",
  ].join("\n");
  sandbox.files.set("package.json", JSON.stringify({
    packageManager: "npm@10.9.8",
    engines: { node: ">=22" },
    scripts: { test: "vitest run", build: "tsc" },
    devDependencies: { vitest: "^3.0.0" },
  }));
  sandbox.files.set("README.md", "# Demo project");
  sandbox.files.set("AGENTS.md", "Use the existing test runner.");
  sandbox.files.set(".github/workflows/ci.yml", "name: CI");

  const profile = await new RepositoryProfileDetector().detect("profile-detection-test", sandbox);

  assert.match(profile.summary, /TypeScript/);
  assert.match(profile.summary, /Package manager: npm/);
  assert.match(profile.summary, /Git revision: a{40}/);
  assert.match(profile.summary, /test = vitest run/);
  assert.match(profile.summary, /Vitest/);
  assert.match(profile.summary, /\.github\/workflows\/ci\.yml/);
  assert.match(profile.summary, /AGENTS\.md \(untrusted repository content\)/);
});

test("repository profile cache is invalidated when the checked-out revision changes", async () => {
  const sandbox = new ProfileSandbox();
  sandbox.listOutput = "README.md\nsrc/index.js";
  sandbox.files.set("README.md", "# Same docs");
  const detector = new RepositoryProfileDetector();
  let revision = "a";
  sandbox.exec = async () => ({ ok: true, data: revision.repeat(40) });

  const first = await detector.detect("profile-revision-invalidation-test", sandbox);
  revision = "b";
  const second = await detector.detect("profile-revision-invalidation-test", sandbox);

  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(second.summary, /Git revision: b{40}/);
});

test("repository profile cache is invalidated when relevant project guidance changes", async () => {
  const sandbox = new ProfileSandbox();
  sandbox.listOutput = "README.md\nAGENTS.md\nsrc/index.js";
  sandbox.files.set("README.md", "# Original");
  sandbox.files.set("AGENTS.md", "Use semicolons.");
  const detector = new RepositoryProfileDetector();

  const original = await detector.detect("profile-cache-invalidation-test", sandbox);
  sandbox.files.set("AGENTS.md", "Use no semicolons.");
  const updated = await detector.detect("profile-cache-invalidation-test", sandbox);

  assert.notEqual(original.fingerprint, updated.fingerprint);
  assert.match(updated.summary, /Use no semicolons/);
});
