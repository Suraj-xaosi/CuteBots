import { SandboxStatus } from "@workspace/types";
import type { PublicProject, ProjectProvisionStatus } from "./project-service.js";

export function toPublicProject(project: {
  id: string;
  name: string;
  repo_url: string;
  context: string;
  github_token: string | null;
  container_id: string | null;
  branch_name: string | null;
  sandbox_status: string;
  provision_status: string;
  provision_error: string | null;
  created_at: Date;
  updated_at: Date;
}): PublicProject {
  return {
    id: project.id,
    name: project.name,
    repo_url: project.repo_url,
    context: project.context,
    github_token_configured: project.github_token !== null,
    container_id: project.container_id,
    branch_name: project.branch_name,
    sandbox_status: toSandboxStatus(project.sandbox_status),
    provision_status: toProvisionStatus(project.provision_status),
    provision_error: project.provision_error,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

export function isGitHubRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.split("/").filter(Boolean).length === 2;
  } catch {
    return false;
  }
}

function toProvisionStatus(status: string) {
  switch (status) {
    case "PENDING":
    case "PROVISIONING":
    case "READY":
    case "FAILED":
      return status;
    default:
      throw new Error(`Unknown project provisioning status: ${status}`);
  }
}

function toSandboxStatus(status: string) {
  if (status === SandboxStatus.RUNNING) return SandboxStatus.RUNNING;
  if (status === SandboxStatus.STOPPED) return SandboxStatus.STOPPED;
  throw new Error(`Unknown sandbox status: ${status}`);
}
