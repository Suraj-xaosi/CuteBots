import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, type Result } from "@workspace/types";
import { AskHumanTool } from "../src/tools/ask-human-tool.js";
import { GitTool } from "../src/tools/git-tool.js";
import {
  FindFilesTool,
  ListFilesTool,
  ReadFileTool,
  RunCommandTool,
  SearchFilesTool,
  StrReplaceTool,
  WriteFileTool,
} from "../src/tools/sandbox-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { UpdatePlanTool } from "../src/tools/update-plan-tool.js";
import { WebSearchTool } from "../src/tools/web-search-tool.js";
import { Sandbox, type CommandJobSnapshot } from "../src/sandbox.js";

class FakeSandbox extends Sandbox {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();

  constructor(private readonly outputs: string[] = []) {
    super("test-project");
  }

  override async exec(command: string): Promise<Result<string>> {
    this.commands.push(command);
    return { ok: true, data: this.outputs.shift() ?? "ok" };
  }

  override async runCommand(command: string): Promise<Result<CommandJobSnapshot>> {
    this.commands.push(command);
    const value = this.outputs.shift() ?? "ok";
    const exitCode = Number(value.match(/Command exited with code (-?\d+)$/)?.[1] ?? 0);
    return {
      ok: true,
      data: {
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        status: "completed",
        output: value,
        nextOffset: Buffer.byteLength(value),
        exitCode,
        outputTruncated: false,
      },
    };
  }

  override async pollCommand(jobId: string): Promise<Result<CommandJobSnapshot>> {
    this.commands.push(`poll ${jobId}`);
    return {
      ok: true,
      data: {
        jobId,
        status: "completed",
        output: "new output",
        nextOffset: 10,
        exitCode: 0,
        outputTruncated: false,
      },
    };
  }

  override async cancelCommand(jobId: string): Promise<Result<void>> {
    this.commands.push(`cancel ${jobId}`);
    return { ok: true, data: undefined };
  }

  override async writeFile(filePath: string, content: string): Promise<Result<void>> {
    this.files.set(filePath, content);
    return { ok: true, data: undefined };
  }

  override async readFile(filePath: string): Promise<Result<string>> {
    const content = this.files.get(filePath);
    return content === undefined
      ? { ok: false, error: "not found", code: ErrorCode.CONTAINER_EXEC_FAILED }
      : { ok: true, data: content };
  }

  override async listFiles(): Promise<Result<string>> {
    return { ok: true, data: [...this.files.keys()].join("\n") };
  }
}

test("run_command keeps non-zero exit status as tool output", async () => {
  const sandbox = new FakeSandbox(["command output\nCommand exited with code 2"]);
  const result = await new RunCommandTool().execute({ command: "false" }, sandbox);

  assert.equal(result.success, true);
  assert.match(result.output, /Command exited with code 2/);
});

test("run_command tells the agent when sandbox output was truncated", async () => {
  const sandbox = new FakeSandbox();
  sandbox.runCommand = async () => ({
    ok: true,
    data: {
      jobId: "123e4567-e89b-42d3-a456-426614174000",
      status: "completed",
      output: "partial output",
      nextOffset: 14,
      exitCode: 0,
      outputTruncated: true,
    },
  });

  const result = await new RunCommandTool().execute({ command: "generate-output" }, sandbox);

  assert.equal(result.success, true);
  assert.match(result.output, /partial output/);
  assert.match(result.output, /Output truncated at the configured limit/);
});

test("poll_command and cancel_command route job IDs to the sandbox", async () => {
  const sandbox = new FakeSandbox();
  const registry = new ToolRegistry({
    taskId: "task-123",
    repositoryUrl: "https://github.com/acme/demo.git",
  });
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  const polled = await registry.execute("poll_command", { job_id: jobId }, sandbox);
  const cancelled = await registry.execute("cancel_command", { job_id: jobId }, sandbox);

  assert.equal(polled.success, true);
  assert.match(polled.output, /new output/);
  assert.equal(cancelled.success, true);
  assert.deepEqual(sandbox.commands, [`poll ${jobId}`, `cancel ${jobId}`]);
});

test("tool schemas reject invalid input before invoking the sandbox", async () => {
  const sandbox = new FakeSandbox();
  const result = await new RunCommandTool().execute({ command: "  " }, sandbox);

  assert.equal(result.success, false);
  assert.match(result.output, /expected string to have >=1 characters/);
  assert.equal(sandbox.commands.length, 0);
});

test("file tools write, read, and list workspace files", async () => {
  const sandbox = new FakeSandbox();
  const written = await new WriteFileTool().execute(
    { path: "src/index.ts", content: "export const value = 1;" },
    sandbox,
  );
  const read = await new ReadFileTool().execute({ path: "src/index.ts" }, sandbox);
  const listed = await new ListFilesTool().execute({ path: "." }, sandbox);

  assert.equal(written.success, true);
  assert.equal(read.output, "export const value = 1;");
  assert.match(listed.output, /src\/index\.ts/);
});

test("find_files filters workspace paths with simple glob patterns", async () => {
  const sandbox = new FakeSandbox();
  sandbox.files.set("src/agent.ts", "export {}");
  sandbox.files.set("src/agent.test.ts", "test");
  sandbox.files.set("README.md", "readme");

  const result = await new FindFilesTool().execute({ directory: ".", glob: "**/*.test.ts" }, sandbox);

  assert.equal(result.success, true);
  assert.equal(result.output, "src/agent.test.ts");
});

test("search_files finds literal text without treating it as a regular expression", async () => {
  const sandbox = new FakeSandbox();
  sandbox.files.set("src/agent.ts", "const value = a+b;\nexport { value };");
  sandbox.files.set("README.md", "No match here.");

  const result = await new SearchFilesTool().execute({
    query: "a+b",
    directory: ".",
    glob: "**/*.ts",
    case_sensitive: true,
    max_results: 10,
  }, sandbox);

  assert.equal(result.success, true);
  assert.equal(result.output, "src/agent.ts:1: const value = a+b;");
});

test("search_files stops promptly when its task has been cancelled", async () => {
  const sandbox = new FakeSandbox();
  const controller = new AbortController();
  controller.abort();

  const result = await new SearchFilesTool().execute({
    query: "anything",
  }, sandbox, controller.signal);

  assert.equal(result.success, false);
  assert.match(result.output, /cancelled before scanning/);
  assert.equal(sandbox.commands.length, 0);
});

test("update_plan persists structured progress through its callback", async () => {
  let published: unknown;
  const tool = new UpdatePlanTool(async (plan) => { published = plan; });

  const result = await tool.execute({
    title: "Improve repository search",
    steps: [
      { description: "Inspect existing tools", status: "completed" },
      { description: "Add bounded search", status: "in_progress" },
    ],
  }, new FakeSandbox());

  assert.equal(result.success, true);
  assert.match(result.output, /Add bounded search/);
  assert.deepEqual(published, {
    title: "Improve repository search",
    steps: [
      { description: "Inspect existing tools", status: "completed" },
      { description: "Add bounded search", status: "in_progress" },
    ],
  });
});

test("update_plan rejects multiple active steps without publishing an invalid plan", async () => {
  let published = false;
  const tool = new UpdatePlanTool(async () => { published = true; });

  const result = await tool.execute({
    title: "Invalid plan",
    steps: [
      { description: "First", status: "in_progress" },
      { description: "Second", status: "in_progress" },
    ],
  }, new FakeSandbox());

  assert.equal(result.success, false);
  assert.equal(published, false);
});

test("repo workflow supports search, inspect, plan, edit, and verify in order", async () => {
  const sandbox = new FakeSandbox(["checks passed"]);
  sandbox.files.set("src/app.js", "const greeting = 'hello';\n");
  const plans: string[] = [];
  const registry = new ToolRegistry({
    taskId: "workflow",
    repositoryUrl: "https://github.com/acme/demo.git",
    publishPlan: async (plan) => { plans.push(plan.title); },
  });

  const found = await registry.execute("find_files", { directory: ".", glob: "**/*.js" }, sandbox);
  const searched = await registry.execute("search_files", {
    query: "greeting",
    directory: ".",
    glob: "**/*.js",
  }, sandbox);
  const inspected = await registry.execute("read_file", { path: "src/app.js" }, sandbox);
  const planned = await registry.execute("update_plan", {
    title: "Update greeting",
    steps: [
      { description: "Inspect the current value", status: "completed" },
      { description: "Change and verify the value", status: "in_progress" },
    ],
  }, sandbox);
  const edited = await registry.execute("str_replace", {
    path: "src/app.js",
    oldText: "'hello'",
    newText: "'hi'",
  }, sandbox);
  const verified = await registry.execute("run_command", { command: "npm test" }, sandbox);

  assert.equal(found.output, "src/app.js");
  assert.match(searched.output, /src\/app\.js:1/);
  assert.match(inspected.output, /greeting = 'hello'/);
  assert.equal(planned.success, true);
  assert.deepEqual(plans, ["Update greeting"]);
  assert.equal(edited.success, true);
  assert.equal(verified.success, true);
  assert.equal(sandbox.files.get("src/app.js"), "const greeting = 'hi';\n");
});

test("git push rejects main and other branches before running git", async () => {
  const sandbox = new FakeSandbox();
  const tool = new GitTool({ repositoryUrl: "https://github.com/acme/demo.git", taskId: "task-123" });
  const result = await tool.execute({ operation: "push", branch: "main" }, sandbox);

  assert.equal(result.success, false);
  assert.match(result.output, /restricted to agent\/task-123/);
  assert.equal(sandbox.commands.length, 0);
});

test("git commit, checkout, and status execute validated operations", async () => {
  const sandbox = new FakeSandbox();
  const tool = new GitTool({ repositoryUrl: "https://github.com/acme/demo.git", taskId: "task-123" });
  tool.setVerifiedEvidence("Verification status: passed", ["src/index.ts"]);
  const committed = await tool.execute({ operation: "commit", message: "fix: user's issue" }, sandbox);
  const checkedOut = await tool.execute({ operation: "checkout", branch: "feature/fix" }, sandbox);
  const status = await tool.execute({ operation: "status" }, sandbox);
  const invalidCheckout = await tool.execute(
    { operation: "checkout", branch: "main; touch /tmp/pwned" },
    sandbox,
  );

  assert.equal(committed.success, true);
  assert.equal(checkedOut.success, true);
  assert.equal(status.success, true);
  assert.equal(invalidCheckout.success, false);
  assert.match(sandbox.commands[0] ?? "", /git add -- .* && git commit/);
  assert.match(sandbox.commands[0] ?? "", /Verification evidence/);
  assert.match(sandbox.commands[1] ?? "", /git switch -- 'feature\/fix'/);
  assert.match(sandbox.commands[2] ?? "", /git status --short --branch/);
  assert.equal(sandbox.commands.length, 3);
});

test("git clone redacts credentials and removes its temporary askpass file", async () => {
  const token = "test-secret-token";
  const sandbox = new FakeSandbox([
    "fatal: not a git repository",
    `fatal: authentication failed ${token}\nCommand exited with code 128`,
    "removed",
  ]);
  const tool = new GitTool({
    repositoryUrl: "https://github.com/acme/demo.git",
    taskId: "task-123",
    readOnlyCloneCredential: token,
  });
  const result = await tool.execute({ operation: "clone" }, sandbox);

  assert.equal(result.success, false);
  assert.equal(result.output.includes(token), false);
  assert.match(sandbox.files.get(".cutebots-askpass-task-123.sh") ?? "", /test-secret-token/);
  assert.match(sandbox.commands[1] ?? "", /chmod 700/);
  assert.match(sandbox.commands[2] ?? "", /rm -f/);
});

test("pull requests send credentials only in the authorization header", async () => {
  const token = "test-secret-token";
  const sandbox = new FakeSandbox(["agent/task-123"]);
  let pullRequestBody: { base: string; body: string } | undefined;
  let approvalQuestion = "";
  const tool = new GitTool({
    repositoryUrl: "https://github.com/acme/demo.git",
    taskId: "task-123",
    githubToken: token,
    humanInteraction: {
      ask: async (question) => {
        approvalQuestion = question;
        return { ok: true, data: "APPROVE" };
      },
    },
    fetcher: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      pullRequestBody = JSON.parse(String(init?.body)) as { base: string; body: string };
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/demo/pull/4" }), {
        status: 201,
      });
    },
  });
  tool.setVerifiedEvidence("Verification status: passed\n- PASS npm test");
  const result = await tool.execute({ operation: "create_pr", title: "Add feature" }, sandbox);

  assert.equal(result.success, true);
  assert.equal(result.output, "https://github.com/acme/demo/pull/4");
  assert.equal(result.output.includes(token), false);
  assert.match(approvalQuestion, /Reply exactly APPROVE/);
  assert.equal(pullRequestBody?.base, "main");
  assert.match(pullRequestBody?.body ?? "", /Verification status: passed/);
});

test("remote delivery requires verified evidence and explicit user approval", async () => {
  const sandbox = new FakeSandbox(["agent/task-123", "agent/task-123", "origin/release"]);
  let requests = 0;
  let approvalQuestion = "";
  const tool = new GitTool({
    repositoryUrl: "https://github.com/acme/demo.git",
    taskId: "task-123",
    githubToken: "test-secret-token",
    humanInteraction: {
      ask: async (question) => {
        approvalQuestion = question;
        return { ok: true, data: "no" };
      },
    },
    fetcher: async () => {
      requests += 1;
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/demo/pull/4" }), { status: 201 });
    },
  });

  const unverified = await tool.execute({ operation: "create_pr", title: "Add feature" }, sandbox);
  const unverifiedCommit = await tool.execute({ operation: "commit", message: "fix issue" }, sandbox);
  tool.setVerifiedEvidence("Verification status: passed");
  const unapproved = await tool.execute({ operation: "create_pr", title: "Add feature" }, sandbox);

  assert.equal(unverified.success, false);
  assert.match(unverified.output, /blocked until.*verification gate/i);
  assert.equal(unverifiedCommit.success, false);
  assert.match(unverifiedCommit.output, /blocked until.*verification gate/i);
  assert.equal(unapproved.success, false);
  assert.match(unapproved.output, /not approved/i);
  assert.match(approvalQuestion, /into release/);
  assert.equal(requests, 0);
});

test("web search degrades cleanly when Tavily is not configured", async () => {
  const result = await new WebSearchTool(undefined).execute({ query: "example" }, new FakeSandbox());

  assert.equal(result.success, false);
  assert.match(result.output, /TAVILY_KEY is not configured/);
});

test("web search limits successful responses to three results", async () => {
  const tool = new WebSearchTool("test-tavily-key", async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; max_results: number };
    assert.equal(request.query, "typescript testing");
    assert.equal(request.max_results, 3);
    return new Response(JSON.stringify({
      results: Array.from({ length: 5 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}` })),
    }), { status: 200 });
  });
  const result = await tool.execute({ query: "typescript testing" }, new FakeSandbox());

  assert.equal(result.success, true);
  assert.equal((JSON.parse(result.output) as unknown[]).length, 3);
  assert.equal(result.output.includes("test-tavily-key"), false);
});

test("ask_human delegates with the ten-minute timeout", async () => {
  let timeout = 0;
  const tool = new AskHumanTool({
    ask: async (_question, timeoutMs) => {
      timeout = timeoutMs;
      return { ok: true, data: "Use the existing API" };
    },
  });
  const result = await tool.execute({ question: "Which API should I use?" }, new FakeSandbox());

  assert.equal(result.success, true);
  assert.equal(result.output, "Use the existing API");
  assert.equal(timeout, 600_000);
});

test("registry exposes repo awareness tools and rejects unknown names", async () => {
  const registry = new ToolRegistry({
    taskId: "task-123",
    repositoryUrl: "https://github.com/acme/demo.git",
    tavilyKey: undefined,
  });
  const result = await registry.execute("missing_tool", {}, new FakeSandbox());

  assert.equal(registry.definitions().length, 13);
  assert.equal(registry.definitions().some((definition) => definition.name === "find_files"), true);
  assert.equal(registry.definitions().some((definition) => definition.name === "search_files"), true);
  assert.equal(registry.definitions().some((definition) => definition.name === "update_plan"), true);
  assert.equal(result.success, false);
  assert.match(result.output, /Unknown tool/);
});

test("str_replace writes only when the exact old text occurs once", async () => {
  const sandbox = new FakeSandbox();
  sandbox.files.set("src/config.ts", "const port = 3000;\n");
  const tool = new StrReplaceTool();
  const replaced = await tool.execute({
    path: "src/config.ts",
    oldText: "3000",
    newText: "3001",
  }, sandbox);
  const missing = await tool.execute({
    path: "src/config.ts",
    oldText: "not present",
    newText: "anything",
  }, sandbox);
  sandbox.files.set("src/repeated.ts", "same same");
  const repeated = await tool.execute({
    path: "src/repeated.ts",
    oldText: "same",
    newText: "changed",
  }, sandbox);

  assert.equal(replaced.success, true);
  assert.equal(sandbox.files.get("src/config.ts"), "const port = 3001;\n");
  assert.equal(missing.success, false);
  assert.equal(sandbox.files.get("src/config.ts"), "const port = 3001;\n");
  assert.equal(repeated.success, false);
  assert.equal(sandbox.files.get("src/repeated.ts"), "same same");
});

test("GitTool prepares a reused workspace from main and warns when pull fails", async () => {
  const sandbox = new FakeSandbox([
    "Switched to branch 'main'",
    "fatal: unable to access origin\nCommand exited with code 1",
    "Switched to a new branch 'agent/task-123'",
  ]);
  const tool = new GitTool({ repositoryUrl: "https://github.com/acme/demo.git", taskId: "task-123" });
  const result = await tool.prepareWorkspace(sandbox, true);

  assert.equal(result.success, true);
  assert.match(result.output, /git pull failed/);
  assert.match(result.output, /agent\/task-123/);
  assert.match(sandbox.commands[0] ?? "", /git switch main/);
  assert.match(sandbox.commands[1] ?? "", /git pull --ff-only origin main/);
  assert.match(sandbox.commands[2] ?? "", /git switch --create/);
});