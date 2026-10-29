import type {
  LLMMessage,
  LLMProvider,
} from "@workspace/types"
import type { ToolRegistry } from "../tools/tool-registry.js"
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunPersistence,
} from "./agent-types.js"
import {
  publishRunLog,
  saveRunMessage,
} from "./agent-loop-persistence.js"
import type { AgentRunGraphStateType } from "./agent-loop-state.js"
import { MAX_ITERATIONS } from "./agent-loop-state.js"
import { codingSystemPrompt } from "./agent-loop-utils.js"
import { chatWithRateLimitRetry } from "./rate-limit-retry.js"

export async function callAgentModel(
  context: AgentRunContext,
  state: AgentRunGraphStateType,
  {
    provider,
    tools,
    persistence,
    channel,
    signal,
  }: {
    provider: LLMProvider
    tools: ToolRegistry
    persistence: AgentRunPersistence
    channel?: AgentChannel
    signal?: AbortSignal
  }
) {
  if (signal?.aborted) throw new Error("Agent run cancelled")
  if (state.iteration >= MAX_ITERATIONS) {
    throw new Error(
      `Agent run reached the maximum iteration count (${MAX_ITERATIONS})`
    )
  }

  await publishRunLog(
    persistence,
    channel,
    context.runId,
    "thinking",
    `Agent iteration ${state.iteration + 1}`
  )

  const toolDefinitions = tools.definitions()
  const systemPrompt = codingSystemPrompt(
    context.runId,
    context.branchName,
    context.projectContext,
    toolDefinitions
  )
  let tokenWrites = Promise.resolve()
  let tokenWriteFailed = false
  let tokenWriteError: unknown
  let tokenBuffer = ""
  let lastTokenFlush = Date.now()

  const flushTokens = () => {
    if (!tokenBuffer) return
    const content = tokenBuffer
    tokenBuffer = ""
    lastTokenFlush = Date.now()
    tokenWrites = tokenWrites.then(async () => {
      if (tokenWriteFailed) return
      try {
        await publishRunLog(
          persistence,
          channel,
          context.runId,
          "assistant_delta",
          content
        )
      } catch (error) {
        tokenWriteFailed = true
        tokenWriteError = error
      }
    })
  }

  const responseRequest = chatWithRateLimitRetry(
    provider,
    state.messages,
    toolDefinitions,
    systemPrompt,
    signal,
    (message) =>
      publishRunLog(persistence, channel, context.runId, "warn", message),
    (token) => {
      tokenBuffer += token
      if (tokenBuffer.length >= 48 || Date.now() - lastTokenFlush >= 50) {
        flushTokens()
      }
    }
  )

  let response: Awaited<typeof responseRequest>
  try {
    response = await responseRequest
  } finally {
    flushTokens()
    await tokenWrites
  }
  if (tokenWriteFailed) throw tokenWriteError
  if (!response.ok) throw new Error(response.error)
  if (response.data.finish_reason === "length") {
    throw new Error("The model response reached its output token limit")
  }
  if (response.data.finish_reason === "error") {
    throw new Error("The model returned an unsuccessful response")
  }

  const assistantMessage: LLMMessage = {
    role: "assistant",
    content: response.data.content ?? "",
    ...(response.data.tool_calls.length
      ? { tool_calls: response.data.tool_calls }
      : {}),
  }
  await saveRunMessage(persistence, context, assistantMessage)

  return {
    messages: [...state.messages, assistantMessage],
    response: response.data,
    iteration: state.iteration + 1,
  }
}
