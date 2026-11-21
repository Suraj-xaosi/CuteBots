import type {
  LLMMessage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from "@workspace/types";

// ===========================================================================
// agent-context.ts  —  context-window management for an autonomous coding agent
//
// Put this file in: packages/core/src/agent/agent-context.ts
//
// Problem it solves
//   Every iteration of the agent loop re-sends the WHOLE history (system prompt,
//   tool schemas, every old tool output, every old write_file body). The old
//   fitToContext() only cut at *user-message boundaries*, and one agent run is
//   a single user turn, so nothing was ever trimmed inside a run.
//
// How it works (cheapest loss first, stops as soon as the prompt fits):
//   0. Budget   = window * ratio - (system prompt + tool schemas) - output reserve
//   1. COMPACT  old tool outputs -> head+tail stubs, old tool-call arguments
//               (e.g. write_file content) -> clipped. 3 escalating tiers.
//               Recent results are always kept intact.
//   2. DROP     whole blocks (assistant tool_calls + its tool results are never
//               split): older user turns first, then the oldest steps of the
//               current turn. A deterministic DIGEST (files edited, commands
//               run + exit codes, user answers, last progress notes) is merged
//               into the current user message so the agent keeps its bearings.
//   3. SQUEEZE  last resort: halve the biggest remaining tool results.
//
// Only what is SENT is trimmed. The database keeps the full history.
// ===========================================================================

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const PER_MESSAGE_OVERHEAD = 6; // role / separators, per message
const MIN_WORK_BLOCKS_KEPT = 2; // newest steps of the current turn are never dropped
const MARKER_ALLOWANCE = 220; // size of a trim marker; avoids re-trimming a stub
const MIN_TOOL_RESULT_CHARS = 800;
const DIGEST_MAX_CHARS = 2_000;
const DIGEST_TOKEN_RESERVE = 700; // room left for the digest when dropping blocks

interface Tier {
  keepRecentResults: number; // newest N tool results are left untouched
  resultChars: number; // older results are cut to ~this many chars
  argChars: number; // old tool-call string args are clipped to this
}

const TIERS: readonly Tier[] = [
  { keepRecentResults: 8, resultChars: 2_000, argChars: 2_000 },
  { keepRecentResults: 4, resultChars: 600, argChars: 500 },
  { keepRecentResults: 2, resultChars: 200, argChars: 200 },
];

// Cap for ONE tool output, applied when it is first produced (before it is
// saved and before it ever enters the context). Old cap was 20k chars.
export const TOOL_OUTPUT_MAX_CHARS = 8_000;
const TOOL_OUTPUT_HEAD = 5_000;
const TOOL_OUTPUT_TAIL = 2_500;

// Append this to codingSystemPrompt(). It tells the model the rules of the game.
export const CONTEXT_MANAGEMENT_PROMPT = [
  "Your context window is limited. Older tool output and file contents may be trimmed from your view and replaced by a short note.",
  "Read in small pieces: use grep, head, tail or sed -n 'START,ENDp'. Never cat large files or dump whole directories.",
  "Do not assume earlier tool output is still visible: re-read the relevant lines before editing a file.",
  "After finishing a sub-step, say in one line what you did and what remains, so that progress survives trimming.",
].join("\n");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export type ContextStage = "none" | "compact" | "drop" | "squeeze";

export interface ContextOptions {
  systemPrompt: string;
  tools: ToolDefinition[];
  /** Share of the window we allow ourselves to fill. Default 0.7. */
  budgetRatio?: number;
  /** Tokens kept free for the model's answer. Default min(4096, 10% of window). */
  outputReserveTokens?: number;
  /**
   * Multiplier on token counts. We count with cl100k, which under-counts
   * Llama / Claude style tokenizers. Default 1.15.
   */
  tokenSafetyFactor?: number;
}

export interface PreparedContext {
  messages: LLMMessage[];
  /** Estimated tokens of `messages` (without system prompt / tools). */
  tokens: number;
  /** Tokens available for `messages` after overhead and output reserve. */
  budget: number;
  /** Tokens used by system prompt + tool schemas. */
  overhead: number;
  stage: ContextStage;
  droppedMessages: number;
}

/** Shrink one tool output: keep the start and the end, say what was cut. */
export function capToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  return headTail(
    output,
    TOOL_OUTPUT_HEAD,
    TOOL_OUTPUT_TAIL,
    "Narrow the command (grep, head, tail, a line range) to see more"
  );
}

export function truncateToolOutput(output: string): string {
  return capToolOutput(output);
}

const INTERRUPTED_RESULT =
  "This tool call was interrupted before it finished. Reassess whether it completed before continuing.";

export function repairToolHistory(messages: LLMMessage[]): LLMMessage[] {
  const repaired: LLMMessage[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < messages.length; index += 1) {
    if (consumed.has(index)) continue;
    const message = messages[index];
    if (!message || message.role === "tool") continue;

    repaired.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    let windowEnd = index + 1;
    while (
      windowEnd < messages.length &&
      messages[windowEnd]?.role !== "assistant"
    ) {
      windowEnd += 1;
    }

    for (const call of message.tool_calls) {
      let found = -1;
      for (
        let candidateIndex = index + 1;
        candidateIndex < windowEnd;
        candidateIndex += 1
      ) {
        const candidate = messages[candidateIndex];
        if (
          !consumed.has(candidateIndex) &&
          candidate?.role === "tool" &&
          candidate.tool_call_id === call.id
        ) {
          found = candidateIndex;
          break;
        }
      }

      if (found >= 0) {
        consumed.add(found);
        repaired.push(messages[found] as LLMMessage);
      } else {
        repaired.push({
          role: "tool",
          tool_call_id: call.id,
          content: INTERRUPTED_RESULT,
        });
      }
    }
  }

  return repaired;
}

export async function fitToContext(
  provider: LLMProvider,
  messages: LLMMessage[]
): Promise<LLMMessage[]> {
  const prepared = await prepareContext(provider, messages, {
    systemPrompt: "",
    tools: [],
  });
  return prepared.messages;
}

/**
 * Build the message list to send to the model for ONE iteration.
 * Call it right before provider.chat(). Safe to call every iteration: it is
 * pure (no DB writes) and caches token counts per message object.
 */
export async function prepareContext(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: ContextOptions
): Promise<PreparedContext> {
  const ratio = options.budgetRatio ?? 0.7;
  const factor = options.tokenSafetyFactor ?? 1.15;
  const window = provider.maxContextTokens;
  const reserve =
    options.outputReserveTokens ?? Math.min(4_096, Math.floor(window * 0.1));

  const overheadRaw = await provider.countTokens([
    {
      role: "user",
      content: options.systemPrompt + JSON.stringify(options.tools),
    },
  ]);
  const overhead = Math.ceil(overheadRaw * factor);
  const budget = Math.max(
    Math.floor(window * ratio) - overhead - reserve,
    Math.floor(window * 0.2)
  );

  const count = async (list: LLMMessage[]) => {
    let sum = 0;
    for (const message of list) sum += await messageTokens(provider, message);
    return Math.ceil(sum * factor);
  };
  const done = (
    list: LLMMessage[],
    tokens: number,
    stage: ContextStage,
    droppedMessages = 0
  ): PreparedContext => ({
    messages: list,
    tokens,
    budget,
    overhead,
    stage,
    droppedMessages,
  });

  let tokens = await count(messages);
  if (tokens <= budget) return done(messages, tokens, "none");

  // 1. COMPACT, escalating
  let working = messages;
  for (const tier of TIERS) {
    working = compactMessages(messages, tier);
    tokens = await count(working);
    if (tokens <= budget) return done(working, tokens, "compact");
  }

  // 2. DROP whole blocks (+ digest)
  const dropped = await dropToFit(provider, working, budget / factor);
  working = dropped.messages;
  tokens = await count(working);
  if (tokens <= budget) {
    return done(working, tokens, "drop", dropped.droppedMessages);
  }

  // 3. SQUEEZE the biggest remaining tool results
  working = await squeeze(working, budget, count);
  tokens = await count(working);
  return done(working, tokens, "squeeze", dropped.droppedMessages);
}

// ---------------------------------------------------------------------------
// Token counting (cached per message object; compaction creates new objects
// only for messages it really changed)
// ---------------------------------------------------------------------------
const tokenCache = new WeakMap<object, number>();

async function messageTokens(
  provider: LLMProvider,
  message: LLMMessage
): Promise<number> {
  const hit = tokenCache.get(message);
  if (hit !== undefined) return hit;
  const tokens =
    (await provider.countTokens([message])) + PER_MESSAGE_OVERHEAD;
  tokenCache.set(message, tokens);
  return tokens;
}

async function blockTokens(
  provider: LLMProvider,
  block: LLMMessage[]
): Promise<number> {
  let sum = 0;
  for (const message of block) sum += await messageTokens(provider, message);
  return sum;
}

// ---------------------------------------------------------------------------
// Stage 1: compaction
// ---------------------------------------------------------------------------
function compactMessages(messages: LLMMessage[], tier: Tier): LLMMessage[] {
  const calls = indexCalls(messages);

  const toolPositions: number[] = [];
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "tool") toolPositions.push(index);
    if (message.role === "assistant") lastAssistant = index;
  });
  const protectedResults = new Set(toolPositions.slice(-tier.keepRecentResults));

  return messages.map((message, index) => {
    if (message.role === "tool") {
      if (
        protectedResults.has(index) ||
        message.content.length <= tier.resultChars + MARKER_ALLOWANCE
      ) {
        return message;
      }
      const head = Math.floor(tier.resultChars * 0.6);
      const tail = tier.resultChars - head;
      return {
        ...message,
        content: headTail(
          message.content,
          head,
          tail,
          `Old output of ${describeCall(calls.get(message.tool_call_id))}; re-run the tool if you need it`
        ),
      };
    }

    // Old tool-call ARGUMENTS can be huge too (write_file sends the whole file).
    if (message.role === "assistant" && index < lastAssistant) {
      const original = message.tool_calls ?? [];
      if (!original.length) return message;
      let changed = false;
      const shrunk = original.map((call) => {
        const args = shrinkArgs(call.arguments, tier.argChars);
        if (args === call.arguments) return call;
        changed = true;
        return { ...call, arguments: args };
      });
      return changed ? { ...message, tool_calls: shrunk } : message;
    }

    return message;
  });
}

function shrinkArgs(
  args: Record<string, unknown>,
  max: number
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > max + MARKER_ALLOWANCE) {
      out[key] =
        `${value.slice(0, max)}\n[... +${value.length - max} chars omitted from history; the file on disk is complete ...]`;
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : args;
}

// ---------------------------------------------------------------------------
// Stage 2: drop whole blocks
//   block = one user message, OR one assistant message together with ALL of its
//   tool results. Blocks are never split, so tool_call / tool pairs stay valid.
// ---------------------------------------------------------------------------
async function dropToFit(
  provider: LLMProvider,
  messages: LLMMessage[],
  rawBudget: number
): Promise<{ messages: LLMMessage[]; droppedMessages: number }> {
  const blocks = toBlocks(messages);

  let anchor = -1; // the user message that started the current turn
  blocks.forEach((block, index) => {
    if (block[0]?.role === "user") anchor = index;
  });
  if (anchor < 0) return { messages, droppedMessages: 0 };

  const sizes: number[] = [];
  for (const block of blocks) sizes.push(await blockTokens(provider, block));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const limit = rawBudget - DIGEST_TOKEN_RESERVE;
  const dropped = new Set<number>();

  // a) older turns, oldest first, always ending on a turn boundary
  let index = 0;
  while (
    index < anchor &&
    (total > limit || blocks[index]?.[0]?.role !== "user")
  ) {
    dropped.add(index);
    total -= sizes[index] ?? 0;
    index += 1;
  }

  // b) oldest steps of the current turn; the newest ones are always kept
  const keepFrom = blocks.length - MIN_WORK_BLOCKS_KEPT;
  for (let j = anchor + 1; j < keepFrom && total > limit; j += 1) {
    dropped.add(j);
    total -= sizes[j] ?? 0;
  }

  if (dropped.size === 0) return { messages, droppedMessages: 0 };

  const droppedMessages = blocks.flatMap((block, i) =>
    dropped.has(i) ? block : []
  );
  const digest = buildDigest(droppedMessages);

  const kept: LLMMessage[] = [];
  blocks.forEach((block, i) => {
    if (dropped.has(i)) return;
    if (i === anchor && block[0]?.role === "user") {
      // Merge the note into the user message: no extra user message, so
      // providers that dislike two user turns in a row stay happy.
      kept.push({ ...block[0], content: `${block[0].content}\n\n${digest}` });
      kept.push(...block.slice(1));
    } else {
      kept.push(...block);
    }
  });

  return { messages: kept, droppedMessages: droppedMessages.length };
}

function toBlocks(messages: LLMMessage[]): LLMMessage[][] {
  const blocks: LLMMessage[][] = [];
  for (const message of messages) {
    const last = blocks[blocks.length - 1];
    if (message.role === "tool" && last) last.push(message);
    else blocks.push([message]);
  }
  return blocks;
}

// Deterministic "what happened" note. No LLM call, no cost, no failure mode.
function buildDigest(dropped: LLMMessage[]): string {
  const calls = indexCalls(dropped);
  const edited = new Set<string>();
  const read = new Set<string>();
  const commands = new Map<string, { text: string; exit?: string }>();
  const other = new Map<string, number>();
  const requests: string[] = [];
  const answers: string[] = [];
  const notes: string[] = [];

  for (const message of dropped) {
    if (message.role === "user") {
      requests.push(clip(message.content, 160));
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim()) notes.push(clip(message.content, 250));
      for (const call of message.tool_calls ?? []) {
        const path = stringArg(call, "path");
        if (call.name === "write_file" || call.name === "str_replace") {
          if (path) edited.add(path);
        } else if (call.name === "read_file") {
          if (path) read.add(path);
        } else if (call.name === "run_command") {
          commands.set(call.id, {
            text: clip(stringArg(call, "command") ?? "", 80),
          });
        } else if (call.name !== "ask_human") {
          other.set(call.name, (other.get(call.name) ?? 0) + 1);
        }
      }
      continue;
    }

    const call = calls.get(message.tool_call_id);
    if (call?.name === "run_command") {
      const code = /Command exited with code (-?\d+)/.exec(message.content)?.[1];
      const entry = commands.get(call.id);
      if (entry && code !== undefined) entry.exit = code;
    } else if (call?.name === "ask_human") {
      answers.push(
        `${clip(stringArg(call, "question") ?? "", 100)} -> ${clip(message.content, 200)}`
      );
    }
  }

  const lines: string[] = [];
  if (requests.length) {
    lines.push(
      `Earlier user requests: ${requests.slice(-4).map((r) => `"${r}"`).join("; ")}`
    );
  }
  if (answers.length) {
    lines.push(`Answers the user already gave: ${answers.slice(-4).join(" | ")}`);
  }
  if (edited.size) lines.push(`Files you edited/wrote: ${list([...edited], 25)}`);
  if (read.size) lines.push(`Files you read: ${list([...read], 15)}`);
  if (commands.size) {
    lines.push(
      `Commands you ran: ${[...commands.values()]
        .slice(-12)
        .map((c) => `${c.text}${c.exit !== undefined ? ` (exit ${c.exit})` : ""}`)
        .join("; ")}`
    );
  }
  if (other.size) {
    lines.push(
      `Other tools used: ${[...other].map(([name, n]) => `${name}x${n}`).join(", ")}`
    );
  }
  if (notes.length) {
    lines.push(`Your latest progress notes before the cut: ${notes.slice(-2).join(" / ")}`);
  }

  const text = [
    `[Context note: ${dropped.length} earlier messages were removed from this prompt to fit the context window.`,
    ...lines,
    "Removed output is not visible any more: re-read files before editing them.]",
  ].join("\n");

  return text.length > DIGEST_MAX_CHARS
    ? `${text.slice(0, DIGEST_MAX_CHARS - 1)}…]`
    : text;
}

// ---------------------------------------------------------------------------
// Stage 3: squeeze
// ---------------------------------------------------------------------------
async function squeeze(
  messages: LLMMessage[],
  budget: number,
  count: (list: LLMMessage[]) => Promise<number>
): Promise<LLMMessage[]> {
  let working = messages;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await count(working)) <= budget) break;

    let target = -1;
    let size = MIN_TOOL_RESULT_CHARS;
    working.forEach((message, index) => {
      if (message.role === "tool" && message.content.length > size) {
        target = index;
        size = message.content.length;
      }
    });
    if (target < 0) break;

    const next = Math.max(MIN_TOOL_RESULT_CHARS, Math.floor(size / 2));
    working = working.map((message, index) =>
      index === target && message.role === "tool"
        ? {
            ...message,
            content: headTail(
              message.content,
              Math.floor(next * 0.6),
              Math.floor(next * 0.4),
              "Cut to fit the context window"
            ),
          }
        : message
    );
  }

  return working;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function headTail(text: string, head: number, tail: number, hint: string): string {
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${omitted} chars omitted. ${hint} ...]\n\n${text.slice(-tail)}`;
}

function indexCalls(messages: LLMMessage[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) calls.set(call.id, call);
  }
  return calls;
}

function stringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : undefined;
}

function describeCall(call: ToolCall | undefined): string {
  if (!call) return "a tool call";
  const key = ["path", "command", "query", "directory", "glob"]
    .map((name) => stringArg(call, name))
    .find((value) => value !== undefined);
  return key ? `${call.name} ${clip(key, 100)}` : call.name;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function list(items: string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}
