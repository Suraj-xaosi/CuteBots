import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sandbox } from "../sandbox.js";
import { redactTextSecrets } from "../security/secret-redaction.js";
import { isCommandFailure, Tool, type ToolResult } from "./tool.js";

const pushChangesSchema = z.object({
  commit_message: z.string().trim().min(1).max(500).describe("Commit message for the project's changes"),
}).strict();

export class PushChangesTool extends Tool<typeof pushChangesSchema> {
  readonly name = "push_changes";
  readonly description = "Commit all workspace changes and push them to the project's working branch. Use only after the user explicitly asks to commit or push; never push to main or master.";
  protected readonly schema = pushChangesSchema;

  constructor(
    private readonly token: string | undefined,
    private readonly repositoryUrl: string,
    private readonly branchName: string,
  ) {
    super();
  }

  protected async executeValidated(
    args: z.output<typeof pushChangesSchema>,
    sandbox: Sandbox,
  ): Promise<ToolResult> {
    if (!this.token) {
      return { success: false, output: "No GitHub token is configured. Add a repository-scoped token with Contents read/write permission before pushing." };
    }
    if (/[\r\n]/.test(this.token)) {
      return { success: false, output: "The configured GitHub token contains invalid newline characters." };
    }
    if (
      !this.branchName ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(this.branchName) ||
      this.branchName.split("/").some((part) => part === "." || part === "..") ||
      /^(main|master)$/i.test(this.branchName)
    ) {
      return { success: false, output: "The project working branch is invalid or protected from agent pushes." };
    }

    const remote = await sandbox.exec("git remote get-url origin");
    if (!remote.ok) return { success: false, output: redactTextSecrets(remote.error) };
    if (isCommandFailure(remote.data)) return { success: false, output: redactTextSecrets(remote.data) };
    if (!sameGitHubRepository(remote.data.trim(), this.repositoryUrl)) {
      return { success: false, output: "The origin remote does not match this project's GitHub repository; refusing to push." };
    }

    const branch = await sandbox.exec("git branch --show-current");
    if (!branch.ok) return { success: false, output: redactTextSecrets(branch.error) };
    if (isCommandFailure(branch.data)) return { success: false, output: redactTextSecrets(branch.data) };
    if (branch.data.trim() !== this.branchName) {
      return { success: false, output: `Current branch ${branch.data.trim() || "(detached)"} is not the project's working branch ${this.branchName}; refusing to push.` };
    }

    const commit = await sandbox.exec(
      `git add --all && if git diff --cached --quiet; then printf '%s\\n' 'No new changes to commit'; else git -c user.name=CuteBots -c user.email=cutebots@localhost commit -m ${shellQuote(args.commit_message)}; fi`,
    );
    if (!commit.ok) return { success: false, output: redactTextSecrets(commit.error) };
    if (isCommandFailure(commit.data)) return { success: false, output: redactTextSecrets(commit.data) };

    const askpassPath = `/tmp/cutebots-askpass-${randomUUID()}.sh`;
    const askpassScript = [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      `  *) printf "%s\\n" ${shellQuote(this.token)} ;;`,
      "esac",
      "",
    ].join("\n");
    const pushed = await sandbox.exec(
      `umask 077; askpass=${shellQuote(askpassPath)}; trap 'rm -f -- "$askpass"' EXIT HUP INT TERM; printf %s ${shellQuote(askpassScript)} > "$askpass" && chmod 700 "$askpass" && GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git push origin HEAD:${shellQuote(this.branchName)}`,
    );
    if (!pushed.ok) {
      return {
        success: false,
        output: `${redactTextSecrets(pushed.error)}\nThe commit remains in the local sandbox; no push was confirmed.`,
      };
    }
    const output = redactTextSecrets(pushed.data);
    if (isCommandFailure(output)) {
      return {
        success: false,
        output: `${output}\nThe commit remains in the local sandbox; no push was confirmed.`,
      };
    }
    return { success: true, output: `${redactTextSecrets(commit.data ?? "")}\n${output}`.trim() };
  }
}

export async function cloneGitHubRepository(
  sandbox: Sandbox,
  repositoryUrl: string,
  projectId: string,
  token?: string,
): Promise<ToolResult> {
  let repository: URL;
  try {
    repository = new URL(repositoryUrl);
  } catch {
    return { success: false, output: "Repository URL is invalid" };
  }
  if (
    repository.protocol !== "https:" ||
    repository.hostname !== "github.com" ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash ||
    repository.pathname.split("/").filter(Boolean).length !== 2
  ) {
    return { success: false, output: "Repository URL must be a clean HTTPS GitHub URL" };
  }
  if (token && /[\r\n]/.test(token)) {
    return { success: false, output: "GitHub token contains invalid newline characters" };
  }

  const existing = await sandbox.exec("git rev-parse --is-inside-work-tree");
  if (existing.ok && existing.data.trim() === "true") {
    return { success: true, output: "Repository is already present in the workspace" };
  }

  const askpassFile = `cutebots-askpass-${randomUUID()}.sh`;
  const workspaceAskpassPath = `/workspace/${askpassFile}`;
  const temporaryAskpassPath = `/tmp/${askpassFile}`;
  if (token) {
    const askpass = [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      `  *) printf "%s\\n" ${shellQuote(token)} ;;`,
      "esac",
      "",
    ].join("\n");
    const written = await sandbox.writeFile(askpassFile, askpass);
    if (!written.ok) return { success: false, output: written.error };
  }

  let result: { ok: boolean; data?: string; error?: string };
  try {
    const authPrefix = token
      ? `mv -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)} && chmod 700 ${shellQuote(temporaryAskpassPath)} && GIT_ASKPASS=${shellQuote(temporaryAskpassPath)} GIT_TERMINAL_PROMPT=0 `
      : "";
    result = await sandbox.exec(`${authPrefix}git clone -- ${shellQuote(repository.href.replace(/\/$/, ""))} .`);
  } finally {
    if (token) {
      const removed = await sandbox.exec(
        `rm -f -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)}`,
      );
      if (!removed.ok) {
        return { success: false, output: "Credential cleanup failed; destroy this sandbox before reuse" };
      }
    }
  }

  const output = redactTextSecrets(result.ok ? result.data ?? "" : result.error ?? "Git clone failed");
  return result.ok && !isCommandFailure(output)
    ? { success: true, output }
    : { success: false, output };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sameGitHubRepository(left: string, right: string) {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
      return url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
    };
    const leftPath = normalize(left);
    return leftPath !== null && leftPath === normalize(right);
  } catch {
    return false;
  }
}
