import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { Result } from "@workspace/types";
import { GitPushBroker } from "../src/tools/git-push-broker.js";
import { Sandbox } from "../src/sandbox.js";

class BundleSandbox extends Sandbox {
  exportedBranch: string | undefined;

  constructor() {
    super("task-123");
  }

  override async exportBranchBundle(branch: string): Promise<Result<Buffer>> {
    this.exportedBranch = branch;
    return { ok: true, data: Buffer.from("test bundle") };
  }
}

test("push broker exports only the task branch and cleans host credentials", async () => {
  const token = "write-token-that-must-stay-host-side";
  const calls: string[][] = [];
  let credentialHelperPath: string | undefined;
  const sandbox = new BundleSandbox();
  const broker = new GitPushBroker(
    "https://github.com/acme/demo.git",
    token,
    async (args) => {
      calls.push(args);
      const helperSetting = args.find((argument) => argument.startsWith("credential.helper=!"));
      if (helperSetting) {
        credentialHelperPath = helperSetting
          .slice("credential.helper=!".length)
          .replace(/^'|'$/g, "");
        assert.equal(existsSync(credentialHelperPath), true);
        assert.equal(readFileSync(credentialHelperPath, "utf8").includes(token), false);
      }
      return { exitCode: 0, output: "" };
    },
  );

  const result = await broker.push("task-123", "agent/task-123", sandbox);

  assert.equal(result.success, true);
  assert.equal(sandbox.exportedBranch, "agent/task-123");
  assert.deepEqual(calls[2]?.slice(-3), [
    "push",
    "origin",
    "refs/heads/agent/task-123:refs/heads/agent/task-123",
  ]);
  assert.equal(JSON.stringify(calls).includes(token), false);
  assert.equal(credentialHelperPath !== undefined && existsSync(credentialHelperPath), false);
});

test("push broker rejects branches outside the task namespace before exporting", async () => {
  const sandbox = new BundleSandbox();
  let commands = 0;
  const broker = new GitPushBroker("https://github.com/acme/demo.git", "token", async () => {
    commands += 1;
    return { exitCode: 0, output: "" };
  });

  const result = await broker.push("task-123", "main", sandbox);

  assert.equal(result.success, false);
  assert.equal(commands, 0);
  assert.equal(sandbox.exportedBranch, undefined);
});