import { ErrorCode, type Result } from "@workspace/types";

export function parseGitHubRepositoryUrl(
  repositoryUrl: string,
): Result<{ cloneUrl: string; owner: string; name: string }> {
  try {
    const url = new URL(repositoryUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return { ok: false, error: "Repository URL must be a clean HTTPS GitHub URL", code: ErrorCode.GITHUB_API_FAILED };
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      return { ok: false, error: "Repository URL must include an owner and repository", code: ErrorCode.GITHUB_API_FAILED };
    }
    const [ownerSegment, repositorySegment] = segments;
    if (!ownerSegment || !repositorySegment) {
      return { ok: false, error: "Repository URL must include an owner and repository", code: ErrorCode.GITHUB_API_FAILED };
    }
    const owner = ownerSegment;
    const name = repositorySegment.replace(/\.git$/i, "");
    if (!owner || !name || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      return { ok: false, error: "Repository URL contains invalid path segments", code: ErrorCode.GITHUB_API_FAILED };
    }
    return { ok: true, data: { cloneUrl: `https://github.com/${owner}/${name}.git`, owner, name } };
  } catch {
    return { ok: false, error: "Repository URL is invalid", code: ErrorCode.GITHUB_API_FAILED };
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isSafeBranch(branch: string): boolean {
  return /^[A-Za-z0-9_./-]+$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    !branch.endsWith("/") &&
    !branch.includes("//");
}

export function safeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "task";
}

export function readApiMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") {
    return data.message;
  }
  return "request failed";
}

export function isPullRequest(data: unknown): data is { html_url: string } {
  return typeof data === "object" && data !== null && "html_url" in data && typeof data.html_url === "string";
}
