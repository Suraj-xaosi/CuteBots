import { Annotation } from "@langchain/langgraph"
import type { LLMMessage, LLMResponse } from "@workspace/types"

export const MAX_ITERATIONS = 25

export const AgentRunGraphState = Annotation.Root({
  messages: Annotation<LLMMessage[]>(),
  response: Annotation<LLMResponse | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  iteration: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
})

export type AgentRunGraphStateType = typeof AgentRunGraphState.State
