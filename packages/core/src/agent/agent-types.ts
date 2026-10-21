import type { AgentRunStatus, LLMMessage, Result } from "@workspace/types";

/**
 * Identifies one agent execution and provides the project context it needs.
 * Created by the run service and passed through the run manager to the agent
 * runtime and loop.
 */
export interface AgentRunContext {
  /** Identifies the execution whose status, messages, and logs are being handled. */
  runId: string;
  /** Identifies the long-lived chat whose full history supplies the agent's context. */
  conversationId: string;
  /** Identifies the project and sandbox the agent is allowed to work in. */
  projectId: string;
  /** Optional Git branch for project operations such as commits and pushes. */
  branchName?: string;
  /** Optional project-specific instructions added to the agent's system context. */
  projectContext?: string;
  /** Marks a restarted execution so the agent can reconcile interrupted tool calls. */
  resume?: boolean;
}

/**
 * The persistence representation of a chat message.
 * Used by the agent loop and persistence adapter to load or save conversation history.
 */
export interface StoredConversationMessage {
  /** The conversation this message belongs to, used to load the complete chat history. */
  conversationId: string;
  /** The run that produced or handled this message; null for messages not tied to a run. */
  runId?: string | null;
  /** LLM-compatible role: user, assistant, or tool. */
  role: LLMMessage["role"];
  /** Plain-text message body or tool output. */
  content: string;
  /** Serialized assistant tool calls, if this assistant message requested tools. */
  toolCallsJson?: string | null;
  /** Associates a tool response with the assistant tool call that requested it. */
  toolCallId?: string | null;
}

/** Event categories written to a run's activity log and shown by the UI. */
export type AgentRunLogType =
  | "thinking"
  | "assistant_delta"
  | "tool_call"
  | "tool_result"
  | "tool_failure"
  | "plan"
  | "evidence"
  | "warn"
  | "error"
  | "status"
  | "message";

/** A persisted run activity event, returned by persistence and streamed to clients. */
export interface AgentRunLogEvent {
  /** Monotonically increasing database ID used for ordering and resuming log streams. */
  id: number;
  /** Identifies the run whose activity this event describes. */
  runId: string;
  /** Describes the kind of activity, such as a tool call, status update, or error. */
  type: AgentRunLogType;
  /** Human-readable event details displayed in the activity timeline. */
  content: string;
  /** Time at which the event was persisted. */
  createdAt: Date;
}

/**
 * Storage operations required by the conversation-based agent loop.
 * Implemented by the database adapter; messages are scoped to conversations,
 * while execution state and activity logs are scoped to individual runs.
 */
export interface AgentRunPersistence {
  /** Loads ordered conversation history so each run can use prior user and agent messages. */
  loadConversationMessages(
    conversationId: string,
  ): Promise<Result<StoredConversationMessage[]>>;
  /** Persists a user, assistant, or tool message in its conversation. */
  appendConversationMessage(
    message: StoredConversationMessage,
  ): Promise<Result<void>>;
  /** Persists a run state transition and an optional failure reason. */
  updateRunStatus(
    runId: string,
    status: AgentRunStatus,
    failReason?: string,
  ): Promise<Result<void>>;
  /** Stores the final human-readable outcome of a run. */
  updateRunSummary(runId: string, summary: string): Promise<Result<void>>;
  /** Persists one activity event and returns its generated ID and timestamp. */
  appendRunLog(
    input: Omit<AgentRunLogEvent, "id" | "createdAt">,
  ): Promise<Result<AgentRunLogEvent>>;
  /** Loads later activity events after a cursor for UI/SSE stream replay. */
  listRunLogsAfter(
    runId: string,
    afterId: number,
    limit: number,
  ): Promise<Result<AgentRunLogEvent[]>>;
}

/**
 * Communication boundary between an agent run and its output channel.
 * Implemented by channel adapters such as the web UI or an external messaging channel.
 */
export interface AgentChannel {
  /** Delivers the agent's final user-facing response through the current channel. */
  sendMessage(text: string): Promise<void>;
  /** Publishes a persisted run event to the channel's live activity stream. */
  sendLog(event: AgentRunLogEvent): Promise<void>;
  /** Waits for a user response when the agent requests human input. */
  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>>;
}

/**
 * Lifecycle contract for an agent execution.
 * Implemented by the runtime and managed by the run manager.
 */
export interface AgentExecutor {
  /** Executes the run using its conversation history and project context. */
  run(context: AgentRunContext): Promise<void>;
  /** Requests cancellation of the currently executing run. */
  stop(): void;
}
