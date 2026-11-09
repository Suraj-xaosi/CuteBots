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
import { fitToContext } from "./agent-loop-history.js"

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
      `The agent used its ${MAX_ITERATIONS}-step limit for one run. Your work is kept; send "continue" to carry on.`
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
  // Only what is SENT is trimmed; stored history is untouched.
  const promptMessages = await fitToContext(provider, state.messages)
  const systemPrompt = codingSystemPrompt(
    context.runId,
    context.branchName,
    context.projectContext,
    toolDefinitions
  )
  let tokenWrites = Promise.resolve()
  let tokenWriteFailed = false
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
        // Live text is a nicety. Losing it must not fail the run.
        tokenWriteFailed = true
        console.warn("Live token updates stopped", { runId: context.runId, error })
      }
    })
  }

  const responseRequest = chatWithRateLimitRetry(
    provider,
    promptMessages,
    toolDefinitions,
    systemPrompt,
    signal,
    (message) =>
      publishRunLog(persistence, channel, context.runId, "warn", message),
    (token) => {
      tokenBuffer += token
      // Bigger batches = far fewer database rows (was every 48 chars / 50 ms).
      if (tokenBuffer.length >= 200 || Date.now() - lastTokenFlush >= 150) {
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