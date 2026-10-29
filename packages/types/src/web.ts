import type {
  AgentRunStatusValue,
  MessageRoleValue,
  ProjectProvisionStatusValue,
  SandboxStatusValue,
} from "./domain.js";
import type { AgentRunLogType } from "./events.js";
import { isProviderName, type ProviderName } from "./llm.js";
import type { ErrorCode } from "./result.js";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: ErrorCode };

export interface ProjectView {
  id: string;
  name: string;
  repositoryUrl: string;
  branchName: string | null;
  context: string;
  sandboxStatus: SandboxStatusValue;
  provisionStatus: ProjectProvisionStatusValue;
  provisionError: string | null;
  hasRepositoryToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectListItem extends ProjectView {
  hasCredentials: boolean;
  setupError?: string | null;
}

export interface CreateProjectInput {
  name: string;
  repositoryUrl: string;
  branchName?: string;
  context?: string;
  repositoryToken?: string;
  provider?: ProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  tavilyApiKey?: string;
}

export interface UpdateProjectInput {
  name?: string;
  branchName?: string | null;
  context?: string;
}

export interface SaveProjectCredentialsInput {
  provider?: ProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  tavilyApiKey?: string;
  repositoryToken?: string;
}

export function isSaveProjectCredentialsInput(
  value: unknown
): value is SaveProjectCredentialsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    (input.provider === undefined || isProviderName(input.provider)) &&
    [
      "apiKey",
      "model",
      "baseUrl",
      "tavilyApiKey",
      "repositoryToken",
    ].every((key) => input[key] === undefined || typeof input[key] === "string")
  );
}

export interface ProjectCredentialsView {
  provider: ProviderName | "";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  hasTavilyApiKey: boolean;
  hasRepositoryToken: boolean;
}

export interface ConversationItem {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  latestRun?: RunItem | null;
}

export interface MessageItem {
  id: string;
  role: MessageRoleValue;
  content: string;
  runId: string | null;
  createdAt: Date;
}

export interface RunItem {
  id: string;
  status: AgentRunStatusValue;
  summary: string | null;
  failReason?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface ActivityItem {
  id: number;
  runId: string;
  type: AgentRunLogType;
  content: string;
  createdAt: Date;
}

export interface ConversationDetails extends ConversationItem {
  messages: MessageItem[];
  runs: RunItem[];
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: number;
}

export interface ProjectFilePreview {
  path: string;
  size: number;
  content: string;
}

export interface SandboxStatusView {
  status: SandboxStatusValue;
  provisionStatus: ProjectProvisionStatusValue;
  error: string | null;
}
