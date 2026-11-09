import type { LLMMessage, LLMProvider } from "@workspace/types";

// ---------------------------------------------------------------------------
// 1. Tool output cap
// A single `cat bigfile` or noisy build used to put up to 5 MB into the model's
// context AND the database. Keep the start and the end, say what was cut.
// ---------------------------------------------------------------------------
export const MAX_TOOL_OUTPUT_CHARS = 20_000;
const KEEP_HEAD_CHARS = 12_000;
const KEEP_TAIL_CHARS = 6_000;

export function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const omitted = output.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS;
  return [
    output.slice(0, KEEP_HEAD_CHARS),
    `[... ${omitted} characters omitted. Narrow the command (grep, head, tail, a line range) to see them ...]`,
    output.slice(-KEEP_TAIL_CHARS),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// 2. Repair tool-call history ("repair on read")
// Provider rule: every assistant tool_call must be answered by a tool message with
// the same id, IMMEDIATELY after it, before any user message. A cancel or crash
// between "assistant asked for a tool" and "tool result saved" breaks that rule and
// the provider rejects the whole conversation forever. This runs on every load, so
// it is idempotent and needs no database writes (and no ordering tricks).
// ---------------------------------------------------------------------------
const INTERRUPTED_RESULT =
  "This tool call was interrupted before it finished. Reassess whether it completed before continuing.";

export function repairToolHistory(messages: LLMMessage[]): LLMMessage[] {
  const repaired: LLMMessage[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < messages.length; index += 1) {
    if (consumed.has(index)) continue;
    const message = messages[index];
    // A tool message nobody claimed is an orphan; providers reject those too.
    if (!message || message.role === "tool") continue;

    repaired.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    // Results for this assistant message can only live before the next assistant message.
    let windowEnd = index + 1;
    while (windowEnd < messages.length && messages[windowEnd]?.role !== "assistant") windowEnd += 1;

    for (const call of message.tool_calls) {
      let found = -1;
      for (let candidateIndex = index + 1; candidateIndex < windowEnd; candidateIndex += 1) {
        const candidate = messages[candidateIndex];
        if (!consumed.has(candidateIndex) && candidate?.role === "tool" && candidate.tool_call_id === call.id) {
          found = candidateIndex;
          break;
        }
      }

      if (found >= 0) {
        consumed.add(found);
        repaired.push(messages[found] as LLMMessage);
      } else {
        repaired.push({ role: "tool", tool_call_id: call.id, content: INTERRUPTED_RESULT });
      }
    }
  }

  return repaired;
}

// ---------------------------------------------------------------------------
// 3. Fit history into the context window
// The whole conversation used to be sent every time, forever. One long chat and
// every future run failed with a context overflow (a "bricked" conversation).
// We only trim what is SENT to the model; the database keeps everything.
// We cut at user-message boundaries so tool_call / tool pairs are never split,
// and we never cut the current turn.
// ---------------------------------------------------------------------------
const CONTEXT_BUDGET_RATIO = 0.7; // token counting is approximate, keep a margin
const TRIM_NOTE: LLMMessage = {
  role: "user",
  content: "[Earlier messages in this conversation were removed to fit the model's context window.]",
};

export async function fitToContext(provider: LLMProvider, messages: LLMMessage[]): Promise<LLMMessage[]> {
  const budget = Math.floor(provider.maxContextTokens * CONTEXT_BUDGET_RATIO);

  const sizes: number[] = [];
  for (const message of messages) sizes.push(await provider.countTokens([message]));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return messages;

  let currentTurnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      currentTurnStart = index;
      break;
    }
  }
  if (currentTurnStart === 0) return messages;

  let remaining = total;
  for (let index = 0; index < currentTurnStart; index += 1) {
    remaining -= sizes[index] ?? 0;
    if (messages[index + 1]?.role === "user" && remaining <= budget) {
      return [TRIM_NOTE, ...messages.slice(index + 1)];
    }
  }

  // Even the current turn alone is big. Send just that; if the provider still
  // refuses, the run fails with the provider's own (clear) message.
  return [TRIM_NOTE, ...messages.slice(currentTurnStart)];
}