import { EventEmitter } from "node:events";
import { ErrorCode, TaskStatus, type LLMMessage, type LLMResponse, type Result } from "@workspace/types";
import type { ContextManager } from "../memory/context-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { Sandbox } from "../sandbox.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentChannel, AgentLogEvent, AgentPersistence, AgentTask } from "./agent-types.js";
import {
  codingSystemPrompt,
  isTransientProviderError,
  toLLMMessage,
  waitWithAbort,
} from "./agent-loop-utils.js";

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_API_RETRY_DELAY_MS = 10_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

export interface AgentLoopOptions {
  maxIterations?: number;
  taskTimeoutMs?: number;
  retryCount?: number;
  apiRetryDelayMs?: number;
  rateLimitDelayMs?: number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  channel?: AgentChannel;
}

export class AgentLoop extends EventEmitter {
  private stopped = false;
  private timedOut = false;
  private controller: AbortController | undefined;
  private activeTaskId: string | undefined;
  private readonly repeatedCommands = new Map<string, number>();
  private readonly options: Omit<Required<AgentLoopOptions>, "channel"> & Pick<AgentLoopOptions, "channel">;

  constructor(
    private readonly persistence: AgentPersistence,
    private readonly provider: import("@workspace/types").LLMProvider,
    private readonly contextManager: ContextManager,
    private readonly tools: ToolRegistry,
    private readonly sandbox: Sandbox,
    private readonly memoryManager?: MemoryManager,
    options: AgentLoopOptions = {},
  ) {
    super();
    this.options = {
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      retryCount: options.retryCount ?? DEFAULT_RETRY_COUNT,
      apiRetryDelayMs: options.apiRetryDelayMs ?? DEFAULT_API_RETRY_DELAY_MS,
      rateLimitDelayMs: options.rateLimitDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS,
      delay: options.delay ?? waitWithAbort,
      channel: options.channel,
    };
  }

  async run(task: AgentTask): Promise<void> {
    if (this.activeTaskId) throw new Error(`Agent loop already owns task ${this.activeTaskId}`);
    this.activeTaskId = task.id;
    this.stopped = false;
    this.timedOut = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const timeout = setTimeout(() => {
      this.timedOut = true;
      this.stop();
    }, this.options.taskTimeoutMs);

    try {
      await this.setStatus(task.id, TaskStatus.RUNNING);
      await this.publish(task.id, "status", "Task started");
      const loaded = await this.persistence.loadMessages(task.id);
      if (!loaded.ok) throw new Error(loaded.error);
      const messages = loaded.data.map(toLLMMessage);
      if (!messages.some((message) => message.role === "user")) {
        const initialMessage: LLMMessage = { role: "user", content: task.description };
        await this.saveMessage(task, initialMessage);
        messages.push(initialMessage);
      }

      for (let iteration = 0; iteration < this.options.maxIterations; iteration += 1) {
        if (signal.aborted) {
          await this.finishAbortedTask(task.id);
          return;
        }

        const context = await this.contextManager.build({
          projectId: task.projectId,
          taskId: task.id,
          systemPrompt: codingSystemPrompt(task.id),
          messages,
        });
        await this.publish(task.id, "thinking", `Agent iteration ${iteration + 1}`);
        const response = await this.callLLMWithRetry(context.messages, context.systemPrompt, signal);
        if (signal.aborted) {
          await this.finishAbortedTask(task.id);
          return;
        }
        if (!response.ok) {
          if (isTransientProviderError(response.code)) {
            await this.pauseTask(task.id, response.error);
          } else {
            await this.failTask(task.id, response.error, response.code);
          }
          return;
        }

        await this.saveTokenUsage(task.id, response.data);
        const assistantMessage: LLMMessage = {
          role: "assistant",
          content: response.data.content ?? "",
          ...(response.data.tool_calls.length ? { tool_calls: response.data.tool_calls } : {}),
        };
        await this.saveMessage(task, assistantMessage);
        messages.push(assistantMessage);

        if (response.data.tool_calls.length === 0) {
          if (!response.data.content?.trim()) {
            await this.failTask(task.id, "LLM returned an empty response", ErrorCode.LLM_API_ERROR);
            return;
          }
          try {
            await this.options.channel?.sendMessage(response.data.content);
          } catch {
            // Channel delivery failure must not change the task result.
          }
          await this.publish(task.id, "status", "Task completed");
          await this.setStatus(task.id, TaskStatus.DONE);
          await this.memoryManager?.captureProjectSummary({
            projectId: task.projectId,
            taskId: task.id,
            summary: response.data.content,
          });
          return;
        }

        for (const toolCall of response.data.tool_calls) {
          if (signal.aborted) {
            await this.finishAbortedTask(task.id);
            return;
          }

          await this.publish(task.id, "tool_call", `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`);
          const repetition = this.trackCommand(toolCall);
          if (repetition >= 5) {
            await this.failTask(task.id, "The same command was requested five times", ErrorCode.TOOL_EXECUTION_FAILED);
            return;
          }

          const result = await this.tools.execute(toolCall.name, toolCall.arguments, this.sandbox, signal);
          const toolMessage: LLMMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.output,
          };
          await this.saveMessage(task, toolMessage);
          messages.push(toolMessage);
          await this.publish(task.id, "tool_result", result.output);
          await this.memoryManager?.captureTaskToolResult({
            projectId: task.projectId,
            taskId: task.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            success: result.success,
            output: result.output,
          });

          if (signal.aborted) {
            await this.finishAbortedTask(task.id);
            return;
          }
          if (toolCall.name === "ask_human" && /human reply timed out/i.test(result.output)) {
            await this.setStatus(task.id, TaskStatus.CANCELLED, result.output);
            await this.publish(task.id, "status", "Task cancelled after human reply timeout");
            return;
          }
          if (repetition === 3) {
            const nudge: LLMMessage = {
              role: "user",
              content: "This command has been repeated three times. Try a different approach.",
            };
            await this.saveMessage(task, nudge);
            messages.push(nudge);
          }
        }
      }

      await this.failTask(task.id, "Task reached the maximum iteration count", ErrorCode.TASK_MAX_ITER_REACHED);
    } catch (error) {
      if (signal.aborted) {
        await this.finishAbortedTask(task.id);
      } else {
        await this.failTask(
          task.id,
          error instanceof Error ? error.message : "Agent loop failed",
          ErrorCode.TOOL_EXECUTION_FAILED,
        );
      }
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
      this.activeTaskId = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private async callLLMWithRetry(
    messages: LLMMessage[],
    systemPrompt: string,
    signal: AbortSignal,
  ): Promise<Result<LLMResponse>> {
    let lastResult: Result<LLMResponse> = {
      ok: false,
      error: "LLM request was not attempted",
      code: ErrorCode.LLM_API_ERROR,
    };

    for (let attempt = 0; attempt < this.options.retryCount; attempt += 1) {
      if (signal.aborted) {
        return { ok: false, error: "Task stopped", code: ErrorCode.TASK_TIMEOUT };
      }

      try {
        lastResult = await this.provider.chat(messages, this.tools.definitions(), systemPrompt);
      } catch (error) {
        lastResult = {
          ok: false,
          error: error instanceof Error ? error.message : "LLM provider request failed",
          code: ErrorCode.LLM_API_ERROR,
        };
      }
      if (lastResult.ok || !isTransientProviderError(lastResult.code)) return lastResult;
      if (attempt + 1 < this.options.retryCount) {
        const delay = lastResult.code === ErrorCode.LLM_RATE_LIMIT
          ? this.options.rateLimitDelayMs
          : this.options.apiRetryDelayMs;
        await this.options.delay(delay, signal).catch(() => undefined);
      }
    }
    return lastResult;
  }

  private async saveMessage(task: AgentTask, message: LLMMessage): Promise<void> {
    const saved = await this.persistence.appendMessage({
      taskId: task.id,
      projectId: task.projectId,
      role: message.role,
      content: message.content,
      toolCallsJson: message.role === "assistant" && message.tool_calls?.length
        ? JSON.stringify(message.tool_calls)
        : null,
      toolCallId: message.role === "tool" ? message.tool_call_id : null,
    });
    if (!saved.ok) throw new Error(saved.error);
  }

  private async saveTokenUsage(taskId: string, response: LLMResponse): Promise<void> {
    const saved = await this.persistence.recordTokenUsage(
      taskId,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
    if (!saved.ok) throw new Error(saved.error);
  }

  private async setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void> {
    const updated = await this.persistence.updateTaskStatus(taskId, status, reason);
    if (!updated.ok) throw new Error(updated.error);
  }

  private async pauseTask(taskId: string, reason: string): Promise<void> {
    await this.setStatus(taskId, TaskStatus.PAUSED, reason);
    await this.publish(taskId, "status", `Task paused: ${reason}`);
  }

  private async failTask(taskId: string, reason: string, code: ErrorCode): Promise<void> {
    await this.setStatus(taskId, TaskStatus.FAILED, `${code}: ${reason}`);
    await this.publish(taskId, "error", reason);
  }

  private async finishAbortedTask(taskId: string): Promise<void> {
    if (this.timedOut) {
      await this.setStatus(taskId, TaskStatus.FAILED, "TASK_TIMEOUT: Task exceeded its 30-minute limit");
      await this.publish(taskId, "error", "Task exceeded its 30-minute limit");
      return;
    }
    if (this.stopped) {
      await this.setStatus(taskId, TaskStatus.CANCELLED, "Task cancelled by user");
      await this.publish(taskId, "status", "Task cancelled");
    }
  }

  private trackCommand(toolCall: { name: string; arguments: Record<string, unknown> }): number {
    if (toolCall.name !== "run_command" || typeof toolCall.arguments.command !== "string") return 0;
    const command = toolCall.arguments.command;
    const count = (this.repeatedCommands.get(command) ?? 0) + 1;
    this.repeatedCommands.set(command, count);
    return count;
  }

  private async publish(
    taskId: string,
    type: AgentLogEvent["type"],
    content: string,
  ): Promise<void> {
    const result = await this.persistence.appendLog({ taskId, type, content });
    if (!result.ok) return;
    try {
      await this.options.channel?.sendLog(result.data);
    } catch {
      // Channel delivery failure must not crash the task loop.
    }
    try {
      this.emit("event", result.data);
    } catch {
      // A channel listener must not crash the task loop.
    }
  }
}