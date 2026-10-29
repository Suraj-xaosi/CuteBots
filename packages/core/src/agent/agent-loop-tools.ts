import {
  AgentRunStatus,
  type LLMMessage,
} from "@workspace/types"
import type { Sandbox } from "../sandbox.js"
import type { ToolRegistry } from "../tools/tool-registry.js"
import {
  redactStructuredSecrets,
  redactTextSecrets,
} from "../security/secret-redaction.js"
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunPersistence,
} from "./agent-types.js"
import {
  publishRunLog,
  saveRunMessage,
  setRunStatus,
} from "./agent-loop-persistence.js"
import type { AgentRunGraphStateType } from "./agent-loop-state.js"

type ToolDependencies = {
  tools: ToolRegistry
  sandbox: Sandbox
  persistence: AgentRunPersistence
  channel?: AgentChannel
  signal?: AbortSignal
}

export async function executeAgentTools(
  context: AgentRunContext,
  state: AgentRunGraphStateType,
  { tools, sandbox, persistence, channel, signal }: ToolDependencies
) {
  const response = state.response
  if (!response) {
    throw new Error("The graph reached the tools node without a model response")
  }

  const messages = [...state.messages]
  for (const toolCall of response.tool_calls) {
    if (signal?.aborted) throw new Error("Agent run cancelled")
    await publishRunLog(
      persistence,
      channel,
      context.runId,
      "tool_call",
      `${toolCall.name} ${JSON.stringify(
        redactStructuredSecrets(toolCall.arguments)
      )}`
    )

    const isWaitingForUser = toolCall.name === "ask_human"
    if (isWaitingForUser) {
      await setRunStatus(persistence, context.runId, AgentRunStatus.WAITING_FOR_INPUT)
      await publishRunLog(
        persistence,
        channel,
        context.runId,
        "status",
        "Agent is waiting for your reply"
      )
    }

    let result: Awaited<ReturnType<ToolRegistry["execute"]>>
    try {
      result = await tools.execute(
        toolCall.name,
        toolCall.arguments,
        sandbox,
        signal,
        context.runId
      )
    } catch (error) {
      if (isWaitingForUser && !signal?.aborted) {
        await setRunStatus(persistence, context.runId, AgentRunStatus.RUNNING)
        await publishRunLog(
          persistence,
          channel,
          context.runId,
          "status",
          "Human input wait ended because an error occurred"
        )
      }
      throw error
    }

    if (isWaitingForUser && !signal?.aborted) {
      await setRunStatus(persistence, context.runId, AgentRunStatus.RUNNING)
      await publishRunLog(
        persistence,
        channel,
        context.runId,
        "status",
        result.success
          ? "Agent received a reply and is continuing"
          : "Agent finished waiting without receiving a reply"
      )
    }

    const safeOutput = redactTextSecrets(result.output)
    const toolMessage: LLMMessage = {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeOutput,
    }
    await saveRunMessage(persistence, context, toolMessage)
    messages.push(toolMessage)
    await publishRunLog(
      persistence,
      channel,
      context.runId,
      result.success ? "tool_result" : "tool_failure",
      safeOutput
    )
  }
  return { messages, response: null }
}

export async function reconcileInterruptedToolCalls(
  context: AgentRunContext,
  messages: LLMMessage[],
  persistence: AgentRunPersistence
) {
  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.tool_calls?.length) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return

  const tail = messages.slice(assistantIndex + 1)
  if (tail.some((message) => message.role !== "tool")) return
  const completedCalls = new Set(
    tail.filter((message) => message.role === "tool").map((message) => message.tool_call_id)
  )
  const assistantMessage = messages[assistantIndex]
  if (
    !assistantMessage ||
    assistantMessage.role !== "assistant" ||
    !assistantMessage.tool_calls
  ) {
    return
  }

  for (const call of assistantMessage.tool_calls) {
    if (completedCalls.has(call.id)) continue
    const interruptedResult: LLMMessage = {
      role: "tool",
      tool_call_id: call.id,
      content:
        "This tool call was interrupted. Reassess whether it completed before continuing.",
    }
    await saveRunMessage(persistence, context, interruptedResult)
    messages.push(interruptedResult)
  }
}
