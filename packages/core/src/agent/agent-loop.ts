import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AgentRunStatus,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
} from "@workspace/types";
import { redactStructuredSecrets, redactTextSecrets } from "../security/secret-redaction.js";
import type { Sandbox } from "../sandbox.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunLogType,
  AgentRunPersistence,
} from "./agent-types.js";
import { codingSystemPrompt, toLLMMessage } from "./agent-loop-utils.js";
import { chatWithRateLimitRetry } from "./rate-limit-retry.js";

const MAX_ITERATIONS = 25;

const AgentRunGraphState = Annotation.Root({
  messages: Annotation<LLMMessage[]>(),
  response: Annotation<LLMResponse | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  iteration: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
});

type AgentRunGraphStateType = typeof AgentRunGraphState.State;

export class AgentLoop {
  private controller: AbortController | undefined;
  private activeRunId: string | undefined;
  private stopped = false;

  constructor(
    private readonly persistence: AgentRunPersistence,
    private readonly provider: LLMProvider,
    private readonly tools: ToolRegistry,
    private readonly sandbox: Sandbox,
    private readonly channel?: AgentChannel,
  ) {}

  async run(context: AgentRunContext): Promise<void> {
    if (this.activeRunId) {
      throw new Error(`Agent already owns run ${this.activeRunId}`);
    }

    this.activeRunId = context.runId;
    this.controller = new AbortController();

    if (this.stopped) {
      this.controller.abort();
    }

    try {
      await this.setStatus(context.runId, AgentRunStatus.RUNNING);
      await this.publish(context.runId, "status", "Agent run started");

      const loaded = await this.persistence.loadConversationMessages(
        context.conversationId,
      );
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }

      const messages = loaded.data.map(toLLMMessage);

      if (!messages.some((message) => message.role === "user")) {
        throw new Error(
          "Cannot start an agent run: the conversation has no user message",
        );
      }

      if (context.resume) {
        await this.reconcileInterruptedToolCalls(context, messages);
      }

      const graph = this.buildGraph(context);
      const result = await graph.invoke(
        { messages, response: null, iteration: 0 },
        {
          signal: this.controller.signal,
          recursionLimit: MAX_ITERATIONS * 2 + 1,
        },
      );

      if (this.controller.signal.aborted) {
        await this.setStatus(
          context.runId,
          AgentRunStatus.INTERRUPTED,
          "Agent run interrupted",
        );
        await this.publish(
          context.runId,
          "status",
          "Agent run interrupted; conversation history is preserved",
        );
        return;
      }

      const finalMessage = result.messages.at(-1);
      if (
        !finalMessage ||
        finalMessage.role !== "assistant" ||
        !finalMessage.content.trim()
      ) {
        throw new Error("The agent finished without a final response");
      }

      const summary = redactTextSecrets(finalMessage.content);
      await this.channel?.sendMessage(summary);

      const savedSummary = await this.persistence.updateRunSummary(
        context.runId,
        summary,
      );
      if (!savedSummary.ok) {
        throw new Error(savedSummary.error);
      }

      await this.setStatus(context.runId, AgentRunStatus.DONE);
      await this.publish(context.runId, "status", "Agent run completed");
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Agent run failed";
      const status = this.controller.signal.aborted
        ? AgentRunStatus.INTERRUPTED
        : AgentRunStatus.FAILED;

      await this.setStatus(context.runId, status, reason);
      await this.publish(
        context.runId,
        status === AgentRunStatus.INTERRUPTED ? "status" : "error",
        reason,
      );
    } finally {
      this.controller = undefined;
      this.activeRunId = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private buildGraph(context: AgentRunContext) {
    return new StateGraph(AgentRunGraphState)
      .addNode("model", (state) => this.callModel(context, state))
      .addNode("tools", (state) => this.executeTools(context, state))
      .addEdge(START, "model")
      .addConditionalEdges(
        "model",
        (state) => (state.response?.tool_calls.length ? "tools" : "done"),
        { tools: "tools", done: END },
      )
      .addEdge("tools", "model")
      .compile();
  }

  private async callModel(
    context: AgentRunContext,
    state: AgentRunGraphStateType,
  ) {
    if (this.controller?.signal.aborted) {
      throw new Error("Agent run cancelled");
    }

    if (state.iteration >= MAX_ITERATIONS) {
      throw new Error(
        `Agent run reached the maximum iteration count (${MAX_ITERATIONS})`,
      );
    }

    await this.publish(
      context.runId,
      "thinking",
      `Agent iteration ${state.iteration + 1}`,
    );

    const toolDefinitions = this.tools.definitions();
    const systemPrompt = codingSystemPrompt(
      context.runId,
      context.branchName,
      context.projectContext,
      toolDefinitions,
    );

    let tokenWrites = Promise.resolve();
    let tokenWriteFailed = false;
    let tokenWriteError: unknown;
    let tokenBuffer = "";
    let lastTokenFlush = Date.now();

    const flushTokens = () => {
      if (!tokenBuffer) return;

      const content = tokenBuffer;
      tokenBuffer = "";
      lastTokenFlush = Date.now();

      tokenWrites = tokenWrites.then(async () => {
        if (tokenWriteFailed) return;

        try {
          await this.publish(context.runId, "assistant_delta", content);
        } catch (error) {
          tokenWriteFailed = true;
          tokenWriteError = error;
        }
      });
    };

    const responseRequest = chatWithRateLimitRetry(
      this.provider,
      state.messages,
      toolDefinitions,
      systemPrompt,
      this.controller?.signal,
      (message) => this.publish(context.runId, "warn", message),
      (token) => {
        tokenBuffer += token;
        if (tokenBuffer.length >= 48 || Date.now() - lastTokenFlush >= 50) {
          flushTokens();
        }
      },
    );

    let response: Awaited<typeof responseRequest>;
    try {
      response = await responseRequest;
    } finally {
      flushTokens();
      await tokenWrites;
    }

    if (tokenWriteFailed) {
      throw tokenWriteError;
    }

    if (!response.ok) {
      throw new Error(response.error);
    }

    if (response.data.finish_reason === "length") {
      throw new Error("The model response reached its output token limit");
    }

    if (response.data.finish_reason === "error") {
      throw new Error("The model returned an unsuccessful response");
    }

    const assistantMessage: LLMMessage = {
      role: "assistant",
      content: response.data.content ?? "",
      ...(response.data.tool_calls.length
        ? { tool_calls: response.data.tool_calls }
        : {}),
    };

    await this.saveMessage(context, assistantMessage);

    return {
      messages: [...state.messages, assistantMessage],
      response: response.data,
      iteration: state.iteration + 1,
    };
  }

  private async executeTools(
    context: AgentRunContext,
    state: AgentRunGraphStateType,
  ) {
    const response = state.response;
    if (!response) {
      throw new Error("The graph reached the tools node without a model response");
    }

    const messages = [...state.messages];

    for (const toolCall of response.tool_calls) {
      if (this.controller?.signal.aborted) {
        throw new Error("Agent run cancelled");
      }

      await this.publish(
        context.runId,
        "tool_call",
        `${toolCall.name} ${JSON.stringify(
          redactStructuredSecrets(toolCall.arguments),
        )}`,
      );

      const result = await this.tools.execute(
        toolCall.name,
        toolCall.arguments,
        this.sandbox,
        this.controller?.signal,
      );

      const safeOutput = redactTextSecrets(result.output);
      const toolMessage: LLMMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: safeOutput,
      };

      await this.saveMessage(context, toolMessage);
      messages.push(toolMessage);

      await this.publish(
        context.runId,
        result.success ? "tool_result" : "tool_failure",
        safeOutput,
      );
    }

    return { messages, response: null };
  }

  private async saveMessage(
    context: AgentRunContext,
    message: LLMMessage,
  ): Promise<void> {
    const saved = await this.persistence.appendConversationMessage({
      conversationId: context.conversationId,
      runId: context.runId,
      role: message.role,
      content: redactTextSecrets(message.content),
      ...(message.role === "assistant" && message.tool_calls?.length
        ? {
            toolCallsJson: JSON.stringify(
              redactStructuredSecrets(message.tool_calls),
            ),
          }
        : {}),
      ...(message.role === "tool"
        ? { toolCallId: message.tool_call_id }
        : {}),
    });

    if (!saved.ok) {
      throw new Error(saved.error);
    }
  }

  private async reconcileInterruptedToolCalls(
    context: AgentRunContext,
    messages: LLMMessage[],
  ): Promise<void> {
    let assistantIndex = -1;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && message.tool_calls?.length) {
        assistantIndex = index;
        break;
      }
    }

    if (assistantIndex < 0) return;

    const tail = messages.slice(assistantIndex + 1);
    if (tail.some((message) => message.role !== "tool")) return;

    const completedCalls = new Set(
      tail
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );

    const assistantMessage = messages[assistantIndex];
    if (
      !assistantMessage ||
      assistantMessage.role !== "assistant" ||
      !assistantMessage.tool_calls
    ) {
      return;
    }

    for (const call of assistantMessage.tool_calls) {
      if (completedCalls.has(call.id)) continue;

      const interruptedResult: LLMMessage = {
        role: "tool",
        tool_call_id: call.id,
        content:
          "This tool call was interrupted. Reassess whether it completed before continuing.",
      };

      await this.saveMessage(context, interruptedResult);
      messages.push(interruptedResult);
    }
  }

  private async setStatus(
    runId: string,
    status: AgentRunStatus,
    reason?: string,
  ): Promise<void> {
    const result = await this.persistence.updateRunStatus(runId, status, reason);
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  private async publish(
    runId: string,
    type: AgentRunLogType,
    content: string,
  ): Promise<void> {
    const result = await this.persistence.appendRunLog({
      runId,
      type,
      content,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    await this.channel?.sendLog(result.data);
  }
}