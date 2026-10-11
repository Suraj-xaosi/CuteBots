import { z } from "zod";
import { isCommandFailure, Tool, type ToolResult } from "./tool.js";
import type { GitPushService } from "./git-push-broker.js";
import type { Sandbox } from "../sandbox.js";
import type { HumanInteraction } from "./ask-human-tool.js";
import { redactTextSecrets } from "../security/secret-redaction.js";
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
  humanInteraction?: HumanInteraction;
  baseBranch?: string;
  fetcher?: typeof fetch;
}

const DELIVERY_APPROVAL_TIMEOUT_MS = 10 * 60 * 1_000;

export class GitTool extends Tool<typeof gitArgsSchema> {
  readonly name = "git_operation";
  readonly description = "Clone, inspect, commit, switch branches, push the task branch, or open a GitHub pull request.";
  protected readonly schema = gitArgsSchema;
  private readonly taskBranch: string;
  private readonly fetcher: typeof fetch;
  private verifiedEvidence: string | undefined;
  private verifiedChangedFiles: string[] = [];
  private readonly baseBranch: string;

  constructor(private readonly options: GitToolOptions) {
    super();
    this.taskBranch = `agent/${options.taskId}`;
    this.fetcher = options.fetcher ?? fetch;
    this.baseBranch = options.baseBranch?.trim() || "main";
  }

  setVerifiedEvidence(evidence?: string, changedFiles: string[] = []): void {
    this.verifiedEvidence = evidence;
    this.verifiedChangedFiles = changedFiles;
  }

  protected async executeValidated(
    args: z.output<typeof gitArgsSchema>,
    sandbox: Sandbox,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    switch (args.operation) {
      case "clone":
        return this.clone(sandbox);
      case "commit":
        return this.commit(sandbox, args.message);
      case "push":
        return this.push(sandbox, args.branch, signal);
      case "checkout":
        return this.checkout(sandbox, args.branch);
      case "status":
        return this.runGit(sandbox, "git status --short --branch");
      case "create_pr":
        return this.createPullRequest(sandbox, args.title, args.body, args.branch, signal);
    }
  }

  async prepareWorkspace(sandbox: Sandbox, workspaceReady: boolean): Promise<ToolResult> {
    if (!isSafeBranch(this.baseBranch)) return this.failed("Configured base branch is invalid");
    let warning = "";
    if (!workspaceReady) {
      const cloned = await this.clone(sandbox);
      if (!cloned.success) return cloned;
    } else {
      const checkoutMain = await this.runGit(sandbox, `git switch ${this.baseBranch}`);
      if (!checkoutMain.success) {
        warning = `WARNING: could not switch to ${this.baseBranch}; creating the task branch from the current checkout. `;
      } else {
        const pulled = await this.runGit(sandbox, `git pull --ff-only origin ${this.baseBranch}`);
        if (!pulled.success) {
          warning = `WARNING: git pull failed; creating the task branch from the last known ${this.baseBranch}. `;
        }
      }
    }

    const branch = await this.runGit(sandbox, `git switch --create ${shellQuote(this.taskBranch)}`);
    if (!branch.success) return branch;
    return { success: true, output: `${warning}Workspace ready on ${this.taskBranch}`.trim() };
  }

  async cloneRepository(sandbox: Sandbox): Promise<ToolResult> {
    return this.clone(sandbox);
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
    if (!this.verifiedEvidence) return this.failed("Commit is blocked until the changed files pass the verification gate");
    if (this.verifiedChangedFiles.length === 0) return this.failed("Commit is blocked because verification found no task-owned changed files");
    const verifiedMessage = redactTextSecrets([
      message,
      "",
      "Verification evidence:",
      this.verifiedEvidence,
    ].join("\n"));
    return this.runGit(
      sandbox,
      `git add -- ${this.verifiedChangedFiles.map(shellQuote).join(" ")} && git commit -m ${shellQuote(verifiedMessage)}`,
    );
  }

  private async push(sandbox: Sandbox, requestedBranch?: string, signal?: AbortSignal): Promise<ToolResult> {
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
    if (!this.verifiedEvidence) return this.failed("Push is blocked until the changed files pass the verification gate");
    const approval = await this.requestDeliveryApproval(
      `push branch ${this.taskBranch} to the repository`,
      signal,
    );
    if (approval) return approval;
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
    signal?: AbortSignal,
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
    if (!this.verifiedEvidence) return this.failed("Pull request creation is blocked until the changed files pass the verification gate");

    const repository = parseGitHubRepositoryUrl(this.options.repositoryUrl);
    if (!repository.ok) return this.failed(repository.error);
    const detectedBase = await sandbox.exec("git symbolic-ref --quiet --short refs/remotes/origin/HEAD");
    const remoteHead = detectedBase.ok ? detectedBase.data.trim() : "";
    const remoteBase = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : "";
    const baseBranch = isSafeBranch(remoteBase) ? remoteBase : this.baseBranch;
    if (!isSafeBranch(baseBranch)) return this.failed("Configured pull request base branch is invalid");
    const approval = await this.requestDeliveryApproval(
      `create a pull request from ${this.taskBranch} into ${baseBranch}`,
      signal,
    );
    if (approval) return approval;

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
            body: redactTextSecrets([
              body?.trim(),
              "## CuteBots verification evidence",
              `Base branch: ${baseBranch}`,
              this.verifiedEvidence,
            ].filter(Boolean).join("\n\n")),
            head: this.taskBranch,
            base: baseBranch,
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

  private async requestDeliveryApproval(target: string, signal?: AbortSignal): Promise<ToolResult | undefined> {
    if (!this.options.humanInteraction) {
      return this.failed("Delivery is blocked because an explicit user approval channel is unavailable");
    }
    const approval = await this.options.humanInteraction.ask(
      `Approve ${target}? Reply exactly APPROVE to continue; any other reply cancels the action.`,
      DELIVERY_APPROVAL_TIMEOUT_MS,
      signal,
    );
    if (!approval.ok) return this.failed(`Delivery approval was not received: ${approval.error}`);
    if (approval.data.trim().toUpperCase() !== "APPROVE") {
      return this.failed("Delivery was not approved; no remote operation was performed");
    }
    return undefined;
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