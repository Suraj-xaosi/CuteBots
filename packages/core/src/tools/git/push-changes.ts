import { randomUUID } from "node:crypto";
import { pushChangesSchema } from "@workspace/types";
import { z } from "zod";
import type { Sandbox } from "../../sandbox.js";
import { redactTextSecrets } from "../../secret-redaction.js";
import { isCommandFailure, Tool, type ToolResult } from "../tool.js";
import { isRiskyPath, sameGitHubRepository, shellQuote } from "./git-helpers.js";

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

    const added = await sandbox.exec("git add --all && git diff --cached --name-only --diff-filter=A");
    if (!added.ok) return { success: false, output: redactTextSecrets(added.error) };
    if (isCommandFailure(added.data)) return { success: false, output: redactTextSecrets(added.data) };

    const risky = added.data.split(/\r?\n/).map((file) => file.trim()).filter((file) => file && isRiskyPath(file));
    if (risky.length) {
      await sandbox.exec("git reset -q");
      return {
        success: false,
        output: `Refusing to commit files that should not be pushed: ${risky.slice(0, 10).join(", ")}${risky.length > 10 ? ", ..." : ""}. Add them to .gitignore or delete them, then try again. Nothing was committed or pushed.`,
      };
    }

    const commit = await sandbox.exec(
      `if git diff --cached --quiet; then printf '%s\\n' 'No new changes to commit'; else git -c user.name=CuteBots -c user.email=cutebots@localhost commit -m ${shellQuote(args.commit_message)}; fi`,
    );
    if (!commit.ok) return { success: false, output: redactTextSecrets(commit.error) };
    if (isCommandFailure(commit.data)) return { success: false, output: redactTextSecrets(commit.data) };

    const askpassFile = `cutebots-askpass-${randomUUID()}.sh`;
    const workspaceAskpassPath = `/workspace/${askpassFile}`;
    const temporaryAskpassPath = `/tmp/${askpassFile}`;
    const askpassScript = [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      `  *) printf "%s\\n" ${shellQuote(this.token)} ;;`,
      "esac",
      "",
    ].join("\n");

    await sandbox.exec(
      "mkdir -p .git/info && (grep -qxF 'cutebots-askpass-*' .git/info/exclude 2>/dev/null || printf '%s\\n' 'cutebots-askpass-*' >> .git/info/exclude)",
    );
    const written = await sandbox.writeFile(askpassFile, askpassScript);
    if (!written.ok) return { success: false, output: redactTextSecrets(written.error) };

    let pushed: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      pushed = await sandbox.exec(
        `umask 077; trap 'rm -f -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)}' EXIT HUP INT TERM; mv -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)} && chmod 700 ${shellQuote(temporaryAskpassPath)} && GIT_ASKPASS=${shellQuote(temporaryAskpassPath)} GIT_TERMINAL_PROMPT=0 git push origin HEAD:${shellQuote(this.branchName)}`,
      );
    } finally {
      await sandbox.exec(`rm -f -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)}`);
    }

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
