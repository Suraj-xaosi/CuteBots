import { randomUUID } from "node:crypto";
import type { Sandbox } from "../../sandbox.js";
import { redactTextSecrets } from "../../secret-redaction.js";
import { isCommandFailure, type ToolResult } from "../tool.js";
import { shellQuote } from "./git-helpers.js";

const CLONE_TIMEOUT_MS = 15 * 60 * 1_000;

export async function cloneGitHubRepository(
  sandbox: Sandbox,
  repositoryUrl: string,
  _projectId: string,
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
    result = await sandbox.exec(`${authPrefix}git clone -- ${shellQuote(repository.href.replace(/\/$/, ""))} .`, CLONE_TIMEOUT_MS);
  } finally {
    if (token) {
      const removed = await sandbox.exec(`rm -f -- ${shellQuote(workspaceAskpassPath)} ${shellQuote(temporaryAskpassPath)}`);
      if (!removed.ok) {
        return { success: false, output: "Credential cleanup failed; destroy this sandbox before reuse" };
      }
    }
  }

  const output = redactTextSecrets(result.ok ? result.data ?? "" : result.error ?? "Git clone failed");
  if (result.ok && !isCommandFailure(output)) return { success: true, output };

  if (/not an empty directory/i.test(output)) {
    return {
      success: false,
      output: "The workspace has leftover files from an interrupted setup. Use Destroy sandbox, then Start it again.",
    };
  }
  if (!result.ok && /timed out/i.test(output)) {
    return {
      success: false,
      output: "Cloning took longer than 15 minutes. The repository may be too large for this sandbox. Use Destroy sandbox before trying again.",
    };
  }
  return { success: false, output };
}
