import { END, START, StateGraph } from "@langchain/langgraph"
import { AgentRunStatus, type LLMProvider } from "@workspace/types"
import { redactTextSecrets } from "../secret-redaction.js"
import type { Sandbox } from "../sandbox.js"
import type { ToolRegistry } from "../tools/tool-registry.js"
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunPersistence,
} from "./agent-types.js"
import { toLLMMessage } from "./agent-loop-utils.js"
import { repairToolHistory } from "./agent-loop-history.js"
import { callAgentModel } from "./agent-loop-model.js"
import {
  publishRunLog,
  setRunStatus,
} from "./agent-loop-persistence.js"
import {
  AgentRunGraphState,
  MAX_ITERATIONS,
} from "./agent-loop-state.js"
import { executeAgentTools } from "./agent-loop-tools.js"

export class AgentLoop {
  private controller: AbortController | undefined
  private activeRunId: string | undefined
  private stopped = false

  constructor(
    private readonly persistence: AgentRunPersistence,
    private readonly provider: LLMProvider,
    private readonly tools: ToolRegistry,
    private readonly sandbox: Sandbox,
    private readonly channel?: AgentChannel
  ) {}

  async run(context: AgentRunContext): Promise<void> {
    if (this.activeRunId) {
      throw new Error(`Agent already owns run ${this.activeRunId}`)
    }

    this.activeRunId = context.runId
    this.controller = new AbortController()
    if (this.stopped) this.controller.abort()

    let commandCleanupComplete = false
    try {
      await setRunStatus(this.persistence, context.runId, AgentRunStatus.RUNNING)
      await publishRunLog(
        this.persistence,
        this.channel,
        context.runId,
        "status",
        "Agent run started"
      )

      const loaded = await this.persistence.loadConversationMessages(
        context.conversationId
      )
      if (!loaded.ok) throw new Error(loaded.error)
      // One unreadable stored message must not brick the whole conversation:
      // skip it, then repair any tool_call that lost its result (cancel / crash).
      const messages = repairToolHistory(
        loaded.data.flatMap((stored) => {
          try {
            return [toLLMMessage(stored)]
          } catch (error) {
            console.warn("Skipping unreadable stored message", { runId: context.runId, error })
            return []
          }
        })
      )
      if (!messages.some((message) => message.role === "user")) {
        throw new Error(
          "Cannot start an agent run: the conversation has no user message"
        )
      }

      const result = await this.buildGraph(context).invoke(
        { messages, response: null, iteration: 0 },
        {
          signal: this.controller.signal,
          recursionLimit: MAX_ITERATIONS * 2 + 1,
        }
      )

      const commandCleanup = await this.sandbox.cancelRunCommands(context.runId)
      if (!commandCleanup.ok) {
        throw new Error(
          `Unable to stop outstanding sandbox commands: ${commandCleanup.error}`
        )
      }
      commandCleanupComplete = true

      if (this.controller.signal.aborted) {
        // Final log FIRST, terminal status LAST: when a viewer sees "finished",
        // every log is already saved and delivered.
        await publishRunLog(
          this.persistence,
          this.channel,
          context.runId,
          "status",
          "Agent run interrupted; conversation history is preserved"
        ).catch(() => undefined)
        await setRunStatus(
          this.persistence,
          context.runId,
          AgentRunStatus.INTERRUPTED,
          "Agent run interrupted"
        )
        return
      }

      const finalMessage = result.messages.at(-1)
      if (
        !finalMessage ||
        finalMessage.role !== "assistant" ||
        !finalMessage.content.trim()
      ) {
        throw new Error("The agent finished without a final response")
      }

      const summary = redactTextSecrets(finalMessage.content)
      await this.channel?.sendMessage(summary)
      const savedSummary = await this.persistence.updateRunSummary(
        context.runId,
        summary
      )
      if (!savedSummary.ok) throw new Error(savedSummary.error)
      await publishRunLog(
        this.persistence,
        this.channel,
        context.runId,
        "status",
        "Agent run completed"
      ).catch(() => undefined)
      await setRunStatus(this.persistence, context.runId, AgentRunStatus.DONE)
    } catch (error) {
      let reason = error instanceof Error ? error.message : "Agent run failed"
      if (!commandCleanupComplete) {
        try {
          const commandCleanup = await this.sandbox.cancelRunCommands(context.runId)
          if (!commandCleanup.ok) {
            reason += `; unable to stop outstanding sandbox commands: ${commandCleanup.error}`
          } else {
            commandCleanupComplete = true
          }
        } catch (cleanupError) {
          const cleanupReason =
            cleanupError instanceof Error
              ? cleanupError.message
              : "unknown sandbox command cleanup error"
          reason += `; unable to stop outstanding sandbox commands: ${cleanupReason}`
        }
      }

      const status = this.controller.signal.aborted
        ? AgentRunStatus.INTERRUPTED
        : AgentRunStatus.FAILED
      await publishRunLog(
        this.persistence,
        this.channel,
        context.runId,
        status === AgentRunStatus.INTERRUPTED ? "status" : "error",
        reason
      ).catch(() => undefined)
      await setRunStatus(this.persistence, context.runId, status, reason)
    } finally {
      this.controller = undefined
      this.activeRunId = undefined
    }
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
  }

  private buildGraph(context: AgentRunContext) {
    return new StateGraph(AgentRunGraphState)
      .addNode("model", (state) =>
        callAgentModel(context, state, {
          provider: this.provider,
          tools: this.tools,
          persistence: this.persistence,
          channel: this.channel,
          signal: this.controller?.signal,
        })
      )
      .addNode("tools", (state) =>
        executeAgentTools(context, state, {
          tools: this.tools,
          sandbox: this.sandbox,
          persistence: this.persistence,
          channel: this.channel,
          signal: this.controller?.signal,
        })
      )
      .addEdge(START, "model")
      .addConditionalEdges(
        "model",
        (state) => (state.response?.tool_calls.length ? "tools" : "done"),
        { tools: "tools", done: END }
      )
      .addEdge("tools", "model")
      .compile()
  }
}