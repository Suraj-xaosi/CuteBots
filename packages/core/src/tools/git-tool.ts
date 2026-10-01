import { z } from "zod";
import { isCommandFailure, Tool, type ToolResult } from "./tool.js";
import type { GitPushService } from "./git-push-broker.js";
import type { Sandbox } from "../sandbox.js";
import {
  isPullRequest,
  isSafeBranch,
  parseGitHubRepositoryUrl,
  readApiMessage,
  safeTaskId,
  shellQuote,
} from "./git-tool-utils.js";

const gitArgsSchema = z.object({
  operation: z.enum(["clone", "commit", "push", "checkout", "status", "create_pr"]),
  branch: z.string().trim().min(1).max(250).optional(),
  message: z.string().trim().min(1).max(10_000).optional(),
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(65_000).optional(),
}).strict();

export interface GitToolOptions {
  repositoryUrl: string;
  taskId: string;
  githubToken?: string;
  readOnlyCloneCredential?: string;
  pushBroker?: GitPushService;
  fetcher?: typeof fetch;
}

export class GitTool extends Tool<typeof gitArgsSchema> {
  readonly name = "git_operation";
  readonly description = "Clone, inspect, commit, switch branches, push the task branch, or open a GitHub pull request.";
  protected readonly schema = gitArgsSchema;
  private readonly taskBranch: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GitToolOptions) {
    super();
    this.taskBranch = `agent/${options.taskId}`;
    this.fetcher = options.fetcher ?? fetch;
  }

  protected async executeValidated(
    args: z.output<typeof gitArgsSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    switch (args.operation) {
      case "clone":
        return this.clone(sandbox);
      case "commit":
        return this.commit(sandbox, args.message);
      case "push":
        return this.push(sandbox, args.branch);
      case "checkout":
        return this.checkout(sandbox, args.branch);
      case "status":
        return this.runGit(sandbox, "git status --short --branch");
      case "create_pr":
        return this.createPullRequest(sandbox, args.title, args.body, args.branch);
    }
  }

  async prepareWorkspace(sandbox: Sandbox, workspaceReady: boolean): Promise<ToolResult> {
    let warning = "";
    if (!workspaceReady) {
      const cloned = await this.clone(sandbox);
      if (!cloned.success) return cloned;
    } else {
      const checkoutMain = await this.runGit(sandbox, "git switch main");
      if (!checkoutMain.success) {
        warning = "WARNING: could not switch to main; creating the task branch from the current checkout. ";
      } else {
        const pulled = await this.runGit(sandbox, "git pull --ff-only origin main");
        if (!pulled.success) {
          warning = "WARNING: git pull failed; creating the task branch from the last known main. ";
        }
      }
    }

    const branch = await this.runGit(sandbox, `git switch --create ${shellQuote(this.taskBranch)}`);
    if (!branch.success) return branch;
    return { success: true, output: `${warning}Workspace ready on ${this.taskBranch}`.trim() };
  }

  private async clone(sandbox: Sandbox): Promise<ToolResult> {
    const repository = parseGitHubRepositoryUrl(this.options.repositoryUrl);
    if (!repository.ok) return this.failed(repository.error);

    const existing = await sandbox.exec("git rev-parse --is-inside-work-tree");
    if (existing.ok && existing.data.trim() === "true") {
      return { success: true, output: "Repository is already present in the workspace" };
    }

    const askpassPath = `.cutebots-askpass-${safeTaskId(this.options.taskId)}.sh`;
    if (this.options.readOnlyCloneCredential) {
      if (/\r|\n/.test(this.options.readOnlyCloneCredential)) {
        return this.failed("Read-only clone credential contains invalid newline characters");
      }
      const askpass = [
        "#!/bin/sh",
        'case "$1" in',
        '  *Username*) printf "%s\\n" "x-access-token" ;;',
        `  *) printf "%s\\n" ${shellQuote(this.options.readOnlyCloneCredential)} ;;`,
        "esac",
        "",
      ].join("\n");
      const written = await sandbox.writeFile(askpassPath, askpass);
      if (!written.ok) return this.failed(written.error);
    }

    let cloneResult: ToolResult;
    try {
      const authPrefix = this.options.readOnlyCloneCredential
        ? `chmod 700 ${shellQuote(`/workspace/${askpassPath}`)} && GIT_ASKPASS=${shellQuote(`/workspace/${askpassPath}`)} GIT_TERMINAL_PROMPT=0 `
        : "";
      cloneResult = await this.runGit(
        sandbox,
        `${authPrefix}git clone -- ${shellQuote(repository.data.cloneUrl)} .`,
      );
    } finally {
      if (this.options.readOnlyCloneCredential) {
        const removed = await sandbox.exec(`rm -f -- ${shellQuote(`/workspace/${askpassPath}`)}`);
        if (!removed.ok || isCommandFailure(removed.data)) {
          cloneResult = this.failed("Credential cleanup failed; destroy this sandbox before reuse");
        }
      }
    }
    return cloneResult;
  }

  private async commit(sandbox: Sandbox, message?: string): Promise<ToolResult> {
    if (!message) return this.failed("A commit message is required");
    return this.runGit(
      sandbox,
      `git add -A && git commit -m ${shellQuote(message)}`,
    );
  }

  private async push(sandbox: Sandbox, requestedBranch?: string): Promise<ToolResult> {
    if (requestedBranch && requestedBranch !== this.taskBranch) {
      return this.failed(`Pushes are restricted to ${this.taskBranch}`);
    }
    const currentBranch = await sandbox.exec("git branch --show-current");
    if (!currentBranch.ok) return this.failed(currentBranch.error);
    if (currentBranch.data.trim() !== this.taskBranch) {
      return this.failed(`Refusing to push: checked-out branch must be ${this.taskBranch}`);
    }
    if (!this.options.pushBroker) {
      return this.failed("Host-side Git push broker is not configured; sandbox cannot push directly");
    }
    const result = await this.options.pushBroker.push(this.options.taskId, this.taskBranch, sandbox);
    return { success: result.success, output: this.redact(result.output) };
  }

  private async checkout(sandbox: Sandbox, branch?: string): Promise<ToolResult> {
    if (!branch || !isSafeBranch(branch)) return this.failed("A valid branch name is required");
    return this.runGit(sandbox, `git switch -- ${shellQuote(branch)}`);
  }

  private async createPullRequest(
    sandbox: Sandbox,
    title?: string,
    body?: string,
    requestedBranch?: string,
  ): Promise<ToolResult> {
    if (!this.options.githubToken) return this.failed("GitHub token is not configured");
    if (!title) return this.failed("A pull request title is required");
    if (requestedBranch && requestedBranch !== this.taskBranch) {
      return this.failed(`Pull requests are restricted to ${this.taskBranch}`);
    }

    const branch = await sandbox.exec("git branch --show-current");
    if (!branch.ok) return this.failed(branch.error);
    if (branch.data.trim() !== this.taskBranch) {
      return this.failed(`Pull requests require the ${this.taskBranch} branch`);
    }

    const repository = parseGitHubRepositoryUrl(this.options.repositoryUrl);
    if (!repository.ok) return this.failed(repository.error);

    try {
      const response = await this.fetcher(
        `https://api.github.com/repos/${repository.data.owner}/${repository.data.name}/pulls`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.options.githubToken}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            title,
            body: body ?? "",
            head: this.taskBranch,
            base: "main",
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const data: unknown = await response.json();
      if (!response.ok) {
        return this.failed(`GitHub API returned ${response.status}: ${readApiMessage(data)}`);
      }
      if (!isPullRequest(data)) return this.failed("GitHub returned an invalid pull request response");
      return { success: true, output: data.html_url };
    } catch (error) {
      return this.failed(error instanceof Error ? error.message : "GitHub API request failed");
    }
  }

  private async runGit(sandbox: Sandbox, command: string): Promise<ToolResult> {
    const result = await sandbox.exec(command);
    if (!result.ok) return this.failed(result.error);
    const output = this.redact(result.data);
    return isCommandFailure(output)
      ? { success: false, output }
      : { success: true, output };
  }

  private redact(output: string): string {
    return [this.options.githubToken, this.options.readOnlyCloneCredential]
      .filter((token): token is string => Boolean(token))
      .reduce((redacted, token) => redacted.split(token).join("***"), output);
  }

  private failed(output: string): ToolResult {
    return { success: false, output: this.redact(output) };
  }
}