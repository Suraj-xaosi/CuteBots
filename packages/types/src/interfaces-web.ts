import type {
  AgentRunStatusValue,
  MessageRoleValue,
  ProjectProvisionStatusValue,
  SandboxStatusValue,
} from "./types-status-agent-and-sandbox.js";
import type { AgentRunLogType } from "./interfaces-agentlog.js";
import type { ProviderName } from "./interfaces-llm.js";
import type { ErrorCode } from "./types-result-errorcode.js";

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

export interface RunDetails extends RunItem {
  conversationId: string;
  lastEventId: number;
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
