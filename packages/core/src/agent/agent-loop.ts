import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { TaskStatus, type LLMMessage, type LLMProvider, type LLMResponse } from "@workspace/types";
import { redactStructuredSecrets, redactTextSecrets } from "../security/secret-redaction.js";
import type { Sandbox } from "../sandbox.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentChannel, AgentPersistence, AgentTask } from "./agent-types.js";
import { codingSystemPrompt, toLLMMessage } from "./agent-loop-utils.js";
import { chatWithRateLimitRetry } from "./rate-limit-retry.js";

const MAX_ITERATIONS = 25;

const TaskGraphState = Annotation.Root({
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

type TaskGraphStateType = typeof TaskGraphState.State;

export class AgentLoop {
  private controller: AbortController | undefined;
  private activeTaskId: string | undefined;
  private stopped = false;

  constructor(
    private readonly persistence: AgentPersistence,
    private readonly provider: LLMProvider,
    private readonly tools: ToolRegistry,
    private readonly sandbox: Sandbox,
    private readonly channel?: AgentChannel,
  ) {}

  async run(task: AgentTask): Promise<void> {
    if (this.activeTaskId) throw new Error(`Agent already owns task ${this.activeTaskId}`);
    this.activeTaskId = task.id;
    this.controller = new AbortController();
    if (this.stopped) this.controller.abort();

    try {
      await this.setStatus(task.id, TaskStatus.RUNNING);
      await this.publish(task.id, "status", "Task started");

      const loaded = await this.persistence.loadMessages(task.id);
      if (!loaded.ok) throw new Error(loaded.error);
      const messages = loaded.data.map(toLLMMessage);
      if (!messages.some((message) => message.role === "user")) {
        const firstMessage: LLMMessage = { role: "user", content: task.description };
        await this.saveMessage(task, firstMessage);
        messages.push(firstMessage);
      }
      if (task.resume) await this.reconcileInterruptedToolCalls(task, messages);
      if (task.continuation) {
        const continuation: LLMMessage = { role: "user", content: task.continuation };
        await this.saveMessage(task, continuation);
        messages.push(continuation);
      }

      const graph = this.buildGraph(task);
      const result = await graph.invoke(
        { messages, response: null, iteration: 0 },
        { signal: this.controller.signal, recursionLimit: MAX_ITERATIONS * 2 + 1 },
      );

      if (this.controller.signal.aborted) {
        await this.setStatus(task.id, TaskStatus.INTERRUPTED, "Task interrupted by the user");
        await this.publish(task.id, "status", "Task interrupted; its history and workspace are preserved");
        return;
      }

      const finalMessage = result.messages.at(-1);
      if (!finalMessage || finalMessage.role !== "assistant" || !finalMessage.content.trim()) {
        throw new Error("The agent finished without a final response");
      }
      await this.channel?.sendMessage(redactTextSecrets(finalMessage.content));
      const summary = redactTextSecrets(finalMessage.content);
      const savedSummary = await this.persistence.updateTaskSummary(task.id, summary);
      if (!savedSummary.ok) throw new Error(savedSummary.error);
      await this.setStatus(task.id, TaskStatus.DONE);
      await this.publish(task.id, "status", "Task completed");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Agent task failed";
      const status = this.controller.signal.aborted ? TaskStatus.INTERRUPTED : TaskStatus.FAILED;
      await this.setStatus(task.id, status, reason);
      await this.publish(task.id, status === TaskStatus.INTERRUPTED ? "status" : "error", reason);
    } finally {
      this.controller = undefined;
      this.activeTaskId = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private buildGraph(task: AgentTask) {
    return new StateGraph(TaskGraphState)
      .addNode("model", (state) => this.callModel(task, state))
      .addNode("tools", (state) => this.executeTools(task, state))
      .addEdge(START, "model")
      .addConditionalEdges(
        "model",
        (state) => state.response?.tool_calls.length ? "tools" : "done",
        { tools: "tools", done: END },
      )
      .addEdge("tools", "model")
      .compile();
  }

  private async callModel(task: AgentTask, state: TaskGraphStateType) {
    if (this.controller?.signal.aborted) throw new Error("Task cancelled");
    if (state.iteration >= MAX_ITERATIONS) {
      throw new Error(`Task reached the maximum iteration count (${MAX_ITERATIONS})`);
    }

    await this.publish(task.id, "thinking", `Agent iteration ${state.iteration + 1}`);
    const toolDefinitions = this.tools.definitions();
    const systemPrompt = codingSystemPrompt(task.id, task.branchName, task.projectContext, toolDefinitions);
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
          await this.publish(task.id, "assistant_delta", content);
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
      (message) => this.publish(task.id, "warn", message),
      (token) => {
        tokenBuffer += token;
        if (tokenBuffer.length >= 48 || Date.now() - lastTokenFlush >= 50) flushTokens();
      },
    );
    let response: Awaited<typeof responseRequest>;
    try {
      response = await responseRequest;
    } finally {
      flushTokens();
      await tokenWrites;
    }
    if (tokenWriteFailed) throw tokenWriteError;
    if (!response.ok) throw new Error(response.error);
    if (response.data.finish_reason === "length") {
      throw new Error("The model response reached its output token limit");
    }
    if (response.data.finish_reason === "error") {
      throw new Error("The model returned an unsuccessful response");
    }

    const assistantMessage: LLMMessage = {
      role: "assistant",
      content: response.data.content ?? "",
      ...(response.data.tool_calls.length ? { tool_calls: response.data.tool_calls } : {}),
    };
    await this.saveMessage(task, assistantMessage);
    return {
      messages: [...state.messages, assistantMessage],
      response: response.data,
      iteration: state.iteration + 1,
    };
  }

  private async executeTools(task: AgentTask, state: TaskGraphStateType) {
    const response = state.response;
    if (!response) throw new Error("The graph reached the tools node without a model response");

    const messages = [...state.messages];
    for (const toolCall of response.tool_calls) {
      if (this.controller?.signal.aborted) throw new Error("Task cancelled");
      await this.publish(
        task.id,
        "tool_call",
        `${toolCall.name} ${JSON.stringify(redactStructuredSecrets(toolCall.arguments))}`,
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
      await this.saveMessage(task, toolMessage);
      messages.push(toolMessage);
      await this.publish(task.id, result.success ? "tool_result" : "tool_failure", safeOutput);
    }
    return { messages, response: null };
  }

  private async saveMessage(task: AgentTask, message: LLMMessage) {
    const saved = await this.persistence.appendMessage({
      taskId: task.id,
      role: message.role,
      content: redactTextSecrets(message.content),
      ...(message.role === "assistant" && message.tool_calls?.length
        ? { toolCallsJson: JSON.stringify(redactStructuredSecrets(message.tool_calls)) }
        : {}),
      ...(message.role === "tool" ? { toolCallId: message.tool_call_id } : {}),
    });
    if (!saved.ok) throw new Error(saved.error);
  }

  private async reconcileInterruptedToolCalls(task: AgentTask, messages: LLMMessage[]) {
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
      tail.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    );
    const assistantMessage = messages[assistantIndex];
    if (!assistantMessage || assistantMessage.role !== "assistant" || !assistantMessage.tool_calls) return;

    for (const call of assistantMessage.tool_calls) {
      if (completedCalls.has(call.id)) continue;
      const interruptedResult: LLMMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: "This tool call was interrupted when the user stopped the task. Reassess it before continuing.",
      };
      await this.saveMessage(task, interruptedResult);
      messages.push(interruptedResult);
    }
  }

  private async setStatus(taskId: string, status: TaskStatus, reason?: string) {
    const result = await this.persistence.updateTaskStatus(taskId, status, reason);
    if (!result.ok) throw new Error(result.error);
  }

  private async publish(
    taskId: string,
    type: "thinking" | "assistant_delta" | "tool_call" | "tool_result" | "tool_failure" | "warn" | "error" | "status" | "message",
    content: string,
  ) {
    const result = await this.persistence.appendLog({ taskId, type, content });
    if (!result.ok) throw new Error(result.error);
    await this.channel?.sendLog(result.data);
  }
}
