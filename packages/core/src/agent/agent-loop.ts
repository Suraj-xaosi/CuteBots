import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
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
import { RepositoryProfileDetector } from "./repo-profile.js";
import { VerificationGate, type VerificationOutcome } from "./verification-gate.js";
import { redactStructuredSecrets, redactTextSecrets } from "../security/secret-redaction.js";

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOTAL_TOKENS = 100_000;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_API_RETRY_DELAY_MS = 10_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;

export interface AgentLoopOptions {
  maxIterations?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
  modelLabel?: string;
  taskTimeoutMs?: number;
  retryCount?: number;
  apiRetryDelayMs?: number;
  rateLimitDelayMs?: number;
  verificationRepairAttempts?: number;
  currentPlan?: () => { title: string; steps: Array<{ description: string; status: string }> } | undefined;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  channel?: AgentChannel;
}

export class AgentLoop extends EventEmitter {
  private stopped = false;
  private timedOut = false;
  private controller: AbortController | undefined;
  private activeTaskId: string | undefined;
  private lastCommand: string | undefined;
  private repeatedCommandCount = 0;
  private currentTaskStatus: TaskStatus | undefined;
  private currentTaskReason: string | undefined;
  private currentToolFailures: Array<{ tool: string; message: string }> = [];
  private readonly hasPricing: boolean;
  private readonly verificationGate: VerificationGate;
  private readonly repositoryProfileDetector = new RepositoryProfileDetector();
  private readonly options: Omit<Required<AgentLoopOptions>, "channel" | "currentPlan" | "modelLabel"> &
    Pick<AgentLoopOptions, "channel" | "currentPlan" | "modelLabel">;

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
    this.verificationGate = new VerificationGate(sandbox);
    this.hasPricing = options.inputCostPerMillionUsd !== undefined && options.outputCostPerMillionUsd !== undefined;
    const maxTotalTokens = options.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
    if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens <= 0) {
      throw new Error("maxTotalTokens must be a positive safe integer");
    }
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new Error("maxCostUsd must be a positive finite number");
    }
    if (options.maxCostUsd !== undefined &&
      (options.inputCostPerMillionUsd === undefined || options.outputCostPerMillionUsd === undefined)) {
      throw new Error("A cost budget requires input and output cost-per-million-token rates");
    }
    for (const [name, rate] of [
      ["inputCostPerMillionUsd", options.inputCostPerMillionUsd],
      ["outputCostPerMillionUsd", options.outputCostPerMillionUsd],
    ] as const) {
      if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) {
        throw new Error(`${name} must be a non-negative finite number`);
      }
    }
    this.options = {
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxTotalTokens,
      maxCostUsd: options.maxCostUsd ?? Number.POSITIVE_INFINITY,
      inputCostPerMillionUsd: options.inputCostPerMillionUsd ?? 0,
      outputCostPerMillionUsd: options.outputCostPerMillionUsd ?? 0,
      taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      retryCount: options.retryCount ?? DEFAULT_RETRY_COUNT,
      apiRetryDelayMs: options.apiRetryDelayMs ?? DEFAULT_API_RETRY_DELAY_MS,
      rateLimitDelayMs: options.rateLimitDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS,
      verificationRepairAttempts: options.verificationRepairAttempts ?? 2,
      delay: options.delay ?? waitWithAbort,
      channel: options.channel,
      currentPlan: options.currentPlan,
      modelLabel: options.modelLabel,
    };
  }

  async run(task: AgentTask): Promise<void> {
    if (this.activeTaskId) throw new Error(`Agent loop already owns task ${this.activeTaskId}`);
    this.activeTaskId = task.id;
    this.currentTaskStatus = TaskStatus.RUNNING;
    this.currentTaskReason = undefined;
    this.currentToolFailures = [];
    this.stopped = false;
    this.timedOut = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const timeout = setTimeout(() => {
      this.timedOut = true;
      this.stop();
    }, this.options.taskTimeoutMs);
    const startedAt = Date.now();
    let baselineChecks: Awaited<ReturnType<VerificationGate["captureBaseline"]>> = [];
    let verificationOutcome: VerificationOutcome | undefined;
    let promptFingerprint: string | undefined;

    try {
      await this.setStatus(task.id, TaskStatus.RUNNING);
      await this.publish(task.id, "status", "Task started");
      let repositoryProfile: string | undefined;
      try {
        const profile = await this.repositoryProfileDetector.detect(task.projectId, this.sandbox, signal);
        repositoryProfile = profile.summary;
        await this.publish(
          task.id,
          "status",
          `Repository profile detected (${profile.fingerprint.slice(0, 12)}; revision ${profile.revision.slice(0, 12)}) and added to agent context.`,
        );
        for (const warning of profile.warnings) {
          await this.publish(task.id, "warn", `Repository profile warning: ${warning}`);
        }
      } catch (error) {
        if (signal.aborted) {
          await this.finishAbortedTask(task.id);
          return;
        }
        const reason = error instanceof Error ? error.message : "Unable to inspect repository profile";
        await this.publish(task.id, "warn", `Repository profile unavailable: ${reason}`);
      }
      baselineChecks = await this.verificationGate.captureBaseline(signal);
      if (signal.aborted) {
        await this.finishAbortedTask(task.id);
        return;
      }
      for (const check of baselineChecks) {
        const type = check.baseline === "failed" ? "warn" : check.baseline === "unknown" ? "warn" : "status";
        await this.publish(
          task.id,
          type,
          `Baseline ${check.baseline}: ${check.command}${check.output ? `\n${check.output}` : ""}`,
        );
      }
      if (baselineChecks.length === 0) {
        await this.publish(task.id, "warn", "No repository baseline checks could be captured.");
      }
      const loaded = await this.persistence.loadMessages(task.id);
      if (!loaded.ok) throw new Error(loaded.error);
      const messages = loaded.data.map(toLLMMessage);
      const storedUsage = await this.persistence.loadTokenUsage(task.id);
      if (!storedUsage.ok) throw new Error(storedUsage.error);
      let totalTokens = storedUsage.data.inputTokens + storedUsage.data.outputTokens;
      let estimatedCostUsd = this.estimateCost(storedUsage.data.inputTokens, storedUsage.data.outputTokens);
      if (!messages.some((message) => message.role === "user")) {
        const initialMessage: LLMMessage = { role: "user", content: task.description };
        await this.saveMessage(task, initialMessage);
        messages.push(initialMessage);
      }

      let verificationRepairAttempts = 0;
      for (let iteration = 0; iteration < this.options.maxIterations; iteration += 1) {
        if (signal.aborted) {
          await this.finishAbortedTask(task.id);
          return;
        }

        const context = await this.contextManager.build({
          projectId: task.projectId,
          taskId: task.id,
          systemPrompt: codingSystemPrompt(task.id, repositoryProfile),
          messages,
          signal,
        });
        promptFingerprint = createHash("sha256").update(context.systemPrompt).digest("hex");
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
        totalTokens += response.data.usage.input_tokens + response.data.usage.output_tokens;
        const assistantMessage: LLMMessage = {
          role: "assistant",
          content: response.data.content ?? "",
          ...(response.data.tool_calls.length ? { tool_calls: response.data.tool_calls } : {}),
        };
        estimatedCostUsd += this.estimateCost(
          response.data.usage.input_tokens,
          response.data.usage.output_tokens,
        );
        if (totalTokens > this.options.maxTotalTokens || estimatedCostUsd > this.options.maxCostUsd) {
          await this.saveMessage(task, assistantMessage);
          messages.push(assistantMessage);
          await this.completeToolCallsWithoutExecution(
            task,
            assistantMessage,
            "Tool call not executed because the task budget was reached.",
            messages,
          );
          const tokenReason = `tokens ${totalTokens}/${this.options.maxTotalTokens}`;
          const costReason = Number.isFinite(this.options.maxCostUsd)
            ? `estimated cost $${estimatedCostUsd.toFixed(6)}/$${this.options.maxCostUsd.toFixed(6)}`
            : undefined;
          await this.pauseTask(task.id, `Task budget reached (${[tokenReason, costReason].filter(Boolean).join("; ")}). Resume with a higher budget to continue.`);
          return;
        }
        if (response.data.finish_reason === "length") {
          await this.failTask(
            task.id,
            "LLM response was incomplete because it reached the output token limit",
            ErrorCode.LLM_API_ERROR,
          );
          return;
        }

        if (response.data.tool_calls.length === 0) {
          if (!response.data.content?.trim()) {
            await this.failTask(task.id, "LLM returned an empty response", ErrorCode.LLM_API_ERROR);
            return;
          }
          const verification = await this.verificationGate.verify(signal);
          verificationOutcome = verification;
          if (signal.aborted) {
            await this.finishAbortedTask(task.id);
            return;
          }
          if (verification.status === "unavailable" || verification.status === "no_changes") {
            const reason = verification.status === "no_changes"
              ? "No workspace changes were detected, so no repository checks could verify the task."
              : verification.reason;
            await this.finishUnverifiedTask(task.id, reason, verification);
            await this.saveMessage(task, assistantMessage);
            messages.push(assistantMessage);
            try {
              await this.options.channel?.sendMessage(`${response.data.content}\n\nVerification status: unverified. ${reason}`);
            } catch {
              // Channel delivery failure must not change the task result.
            }
            return;
          }
          if (verification.status === "failed") {
            await this.publishVerificationResult(task.id, verification);
            const preExistingFailures = verification.checks.filter(
              (check) => !check.passed && check.baseline === "failed",
            );
            const actionableFailures = verification.checks.filter(
              (check) => !check.passed && check.baseline !== "failed",
            );
            if (actionableFailures.length === 0 && preExistingFailures.length > 0) {
              const reason = `Checks already failed at task start: ${preExistingFailures.map((check) => check.command).join(", ")}`;
              await this.finishUnverifiedTask(task.id, reason, verification);
              await this.saveMessage(task, assistantMessage);
              messages.push(assistantMessage);
              try {
                await this.options.channel?.sendMessage(
                  `${response.data.content}\n\nVerification status: unverified. ${reason}`,
                );
              } catch {
                // Channel delivery failure must not change the task result.
              }
              return;
            }
            if (verificationRepairAttempts < this.options.verificationRepairAttempts) {
              verificationRepairAttempts += 1;
              const repairMessage: LLMMessage = {
                role: "user",
                content: verificationRepairPrompt(
                  verification,
                  verificationRepairAttempts,
                  this.options.verificationRepairAttempts,
                ),
              };
              await this.saveMessage(task, repairMessage);
              messages.push(repairMessage);
              continue;
            }
            await this.failTask(
              task.id,
              `Verification failed after ${verificationRepairAttempts} repair attempt(s): ${verificationFailureSummary(verification)}`,
              ErrorCode.TOOL_EXECUTION_FAILED,
            );
            return;
          }
          await this.publishVerificationResult(task.id, verification);
          await this.saveMessage(task, assistantMessage);
          messages.push(assistantMessage);
          try {
            await this.options.channel?.sendMessage(redactTextSecrets(response.data.content));
          } catch {
            // Channel delivery failure must not change the task result.
          }
          await this.publish(task.id, "status", "Task completed");
          await this.setStatus(task.id, TaskStatus.DONE);
          this.memoryManager?.enqueueProjectSummary({
            projectId: task.projectId,
            taskId: task.id,
            summary: response.data.content,
          });
          return;
        }
        await this.saveMessage(task, assistantMessage);
        messages.push(assistantMessage);
        let shouldNudge = false;
        for (const [toolIndex, toolCall] of response.data.tool_calls.entries()) {
          if (signal.aborted) {
            await this.completeToolCallsWithoutExecution(
              task,
              assistantMessage,
              "Tool call not executed because the task was cancelled.",
              messages,
              toolIndex,
            );
            await this.finishAbortedTask(task.id);
            return;
          }

          await this.publish(
            task.id,
            "tool_call",
            `${toolCall.name} ${JSON.stringify(redactStructuredSecrets(toolCall.arguments))}`,
          );
          const repetition = this.trackCommand(toolCall);
          if (repetition >= 5) {
            await this.completeToolCallsWithoutExecution(
              task,
              assistantMessage,
              "Tool call not executed because the repeated-command guard paused this task.",
              messages,
              toolIndex,
            );
            await this.pauseTask(task.id, "The same command was requested five times without progress; review the partial work and choose a different approach.");
            return;
          }

          let result: Awaited<ReturnType<ToolRegistry["execute"]>>;
          if (
            toolCall.name === "git_operation" &&
            (toolCall.arguments.operation === "commit" ||
              toolCall.arguments.operation === "push" ||
              toolCall.arguments.operation === "create_pr")
          ) {
            const deliveryVerification = await this.verificationGate.verify(signal);
            verificationOutcome = deliveryVerification;
            await this.publishVerificationResult(task.id, deliveryVerification);
            if (signal.aborted) {
              await this.completeToolCallsWithoutExecution(
                task,
                assistantMessage,
                "Tool call not executed because the task was cancelled during delivery verification.",
                messages,
                toolIndex,
              );
              await this.finishAbortedTask(task.id);
              return;
            }
            if (deliveryVerification.status === "passed") {
              this.tools.setVerifiedDeliveryEvidence(
                formatDeliveryEvidence(deliveryVerification),
                deliveryVerification.changedFiles,
              );
              result = await this.tools.execute(toolCall.name, toolCall.arguments, this.sandbox, signal);
            } else {
              this.tools.setVerifiedDeliveryEvidence(undefined);
              result = {
                success: false,
                output: `Remote delivery is blocked until verification passes. Current verification status: ${deliveryVerification.status}.`,
              };
            }
          } else {
            result = await this.tools.execute(toolCall.name, toolCall.arguments, this.sandbox, signal);
          }
          const safeOutput = redactTextSecrets(result.output);
          const toolMessage: LLMMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: safeOutput,
          };
          await this.saveMessage(task, toolMessage);
          messages.push(toolMessage);
          await this.publish(task.id, "tool_result", safeOutput);
          if (!result.success) {
            this.currentToolFailures.push({ tool: toolCall.name, message: safeOutput.slice(0, 2_000) });
            await this.publishStructured(task.id, "tool_failure", {
              tool: toolCall.name,
              message: safeOutput.slice(0, 2_000),
            });
          }
          this.memoryManager?.enqueueTaskToolResult({
            projectId: task.projectId,
            taskId: task.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            success: result.success,
            output: safeOutput,
          });

          if (signal.aborted) {
            await this.completeToolCallsWithoutExecution(
              task,
              assistantMessage,
              "Tool call not executed because the task was cancelled.",
              messages,
              toolIndex + 1,
            );
            await this.finishAbortedTask(task.id);
            return;
          }
          if (toolCall.name === "ask_human" && /human reply timed out/i.test(result.output)) {
            await this.completeToolCallsWithoutExecution(
              task,
              assistantMessage,
              "Tool call not executed because the human reply timed out.",
              messages,
              toolIndex + 1,
            );
            await this.setStatus(task.id, TaskStatus.CANCELLED, result.output);
            await this.publish(task.id, "status", "Task cancelled after human reply timeout");
            return;
          }
          if (repetition === 3) shouldNudge = true;
        }
        if (shouldNudge) {
          const nudge: LLMMessage = {
            role: "user",
            content: "This command has been repeated three times. Try a different approach.",
          };
          await this.saveMessage(task, nudge);
          messages.push(nudge);
        }
      }

      await this.pauseTask(task.id, `Task reached the maximum iteration count (${this.options.maxIterations}); review the partial work before resuming.`);
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
      await this.writeCompletionReport(task, {
        startedAt,
        baselineChecks,
        verification: verificationOutcome,
        promptFingerprint,
      });
      clearTimeout(timeout);
      this.controller = undefined;
      this.activeTaskId = undefined;
      this.currentTaskStatus = undefined;
      this.currentTaskReason = undefined;
      this.currentToolFailures = [];
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
        lastResult = await this.provider.chat(messages, this.tools.definitions(), systemPrompt, signal);
      } catch (error) {
        lastResult = {
          ok: false,
          error: error instanceof Error ? error.message : "LLM provider request failed",
          code: ErrorCode.LLM_API_ERROR,
        };
      }
      if (lastResult.ok || !isTransientProviderError(lastResult.code)) return lastResult;
      if (attempt + 1 < this.options.retryCount) {
        const requestedDelay = lastResult.retryAfterMs;
        const delay = requestedDelay === undefined
          ? lastResult.code === ErrorCode.LLM_RATE_LIMIT
            ? this.options.rateLimitDelayMs
            : this.options.apiRetryDelayMs
          : Math.min(requestedDelay, MAX_RETRY_AFTER_MS);
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
      content: redactTextSecrets(message.content),
      toolCallsJson: message.role === "assistant" && message.tool_calls?.length
        ? JSON.stringify(redactStructuredSecrets(message.tool_calls))
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

  private estimateCost(inputTokens: number, outputTokens: number): number {
    return (
      inputTokens * this.options.inputCostPerMillionUsd +
      outputTokens * this.options.outputCostPerMillionUsd
    ) / 1_000_000;
  }

  private async completeToolCallsWithoutExecution(
    task: AgentTask,
    assistantMessage: LLMMessage,
    reason: string,
    messages: LLMMessage[],
    startIndex = 0,
  ): Promise<void> {
    if (assistantMessage.role !== "assistant") return;
    for (const toolCall of (assistantMessage.tool_calls ?? []).slice(startIndex)) {
      const toolMessage: LLMMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: reason,
      };
      await this.saveMessage(task, toolMessage);
      messages.push(toolMessage);
    }
  }

  private async setStatus(taskId: string, status: TaskStatus, reason?: string): Promise<void> {
    const updated = await this.persistence.updateTaskStatus(taskId, status, reason);
    if (!updated.ok) throw new Error(updated.error);
    this.currentTaskStatus = status;
    this.currentTaskReason = reason;
  }

  private async pauseTask(taskId: string, reason: string): Promise<void> {
    await this.setStatus(taskId, TaskStatus.PAUSED, reason);
    await this.publish(taskId, "status", `Task paused: ${reason}`);
  }

  private async failTask(taskId: string, reason: string, code: ErrorCode): Promise<void> {
    await this.setStatus(taskId, TaskStatus.FAILED, `${code}: ${reason}`);
    await this.publish(taskId, "error", reason);
  }

  private async finishUnverifiedTask(
    taskId: string,
    reason: string,
    outcome: VerificationOutcome,
  ): Promise<void> {
    await this.setStatus(taskId, TaskStatus.UNVERIFIED, reason);
    await this.publishVerificationResult(taskId, outcome);
    await this.publish(taskId, "status", `Task finished without verified success: ${reason}`);
  }

  private async publishVerificationResult(taskId: string, outcome: VerificationOutcome): Promise<void> {
    if (outcome.changedFiles.length > 0) {
      await this.publish(taskId, "status", `Verification scope: ${outcome.changedFiles.join(", ")}`);
    }
    if (outcome.status === "passed") {
      await this.publish(
        taskId,
        "status",
        `Verification passed: ${outcome.checks.length} check(s); changed files: ${outcome.changedFiles.join(", ")}`,
      );
      for (const check of outcome.checks) {
        await this.publish(taskId, "status", `PASS ${check.command} (exit 0; baseline ${check.baseline})`);
      }
      return;
    }
    if (outcome.status === "failed") {
      for (const check of outcome.checks) {
        const severity = check.passed
          ? "status"
          : check.baseline === "failed"
            ? "warn"
            : "error";
        await this.publish(
          taskId,
          severity,
          `${check.passed ? "PASS" : check.baseline === "failed" ? "PRE-EXISTING FAIL" : "FAIL"} ${check.command} (baseline ${check.baseline})\n${check.output}`,
        );
      }
      return;
    }
    if (outcome.status === "unavailable" && outcome.checks) {
      for (const check of outcome.checks) {
        await this.publish(
          taskId,
          "warn",
          `Could not reliably run ${check.command}\n${check.output}`,
        );
      }
    }
    const reason = outcome.status === "unavailable"
      ? outcome.reason
      : "No workspace changes were detected; repository checks were not run.";
    await this.publish(taskId, "warn", `Verification unavailable: ${reason}`);
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
    if (toolCall.name !== "run_command" || typeof toolCall.arguments.command !== "string") {
      this.lastCommand = undefined;
      this.repeatedCommandCount = 0;
      return 0;
    }
    const command = toolCall.arguments.command;
    this.repeatedCommandCount = command === this.lastCommand ? this.repeatedCommandCount + 1 : 1;
    this.lastCommand = command;
    return this.repeatedCommandCount;
  }

  private async publish(
    taskId: string,
    type: AgentLogEvent["type"],
    content: string,
  ): Promise<void> {
    content = redactTextSecrets(content);
    const result = await this.persistence.appendLog({ taskId, type, content });
    if (!result.ok) {
      console.error(`Unable to persist ${type} event for task ${taskId}: ${result.error}`);
      return;
    }
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

  private async publishStructured(
    taskId: string,
    type: Extract<AgentLogEvent["type"], "tool_failure" | "plan" | "evidence">,
    value: unknown,
  ): Promise<void> {
    const content = JSON.stringify(redactStructuredSecrets(value));
    const result = await this.persistence.appendLog({ taskId, type, content });
    if (!result.ok) {
      console.error(`Unable to persist ${type} event for task ${taskId}: ${result.error}`);
      return;
    }
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

  private async writeCompletionReport(
    task: AgentTask,
    input: {
      startedAt: number;
      baselineChecks: Awaited<ReturnType<VerificationGate["captureBaseline"]>>;
      verification?: VerificationOutcome;
      promptFingerprint?: string;
    },
  ): Promise<void> {
    try {
      const inspection = input.verification
        ? { files: input.verification.changedFiles, error: undefined }
        : await this.verificationGate.inspectChangedFiles(undefined, true);
      const changedFiles = inspection.files;
      const usageResult = await this.persistence.loadTokenUsage(task.id);
      if (!usageResult.ok) {
        console.error(`Unable to load token usage for task ${task.id}: ${usageResult.error}`);
      }
      const usage = usageResult.ok ? usageResult.data : undefined;
      const status = this.currentTaskStatus ?? TaskStatus.RUNNING;
      const plan = this.options.currentPlan?.();
      const currentStep = plan?.steps.find((step) => step.status === "in_progress");
      const config = {
        schemaVersion: "task-report-v1",
        provider: this.provider.name,
        model: this.options.modelLabel ?? this.provider.name,
        maxTotalTokens: this.options.maxTotalTokens,
        maxCostUsd: Number.isFinite(this.options.maxCostUsd) ? this.options.maxCostUsd : null,
        inputCostPerMillionUsd: this.hasPricing ? this.options.inputCostPerMillionUsd : null,
        outputCostPerMillionUsd: this.hasPricing ? this.options.outputCostPerMillionUsd : null,
        verificationRepairAttempts: this.options.verificationRepairAttempts,
        taskTimeoutMs: this.options.taskTimeoutMs,
      };
      const verificationChecks = input.verification && "checks" in input.verification
        ? input.verification.checks ?? []
        : [];
      const failedChecks = verificationChecks.filter((check) => !check.passed);
      const verificationReason = input.verification?.status === "unavailable"
        ? input.verification.reason
        : input.verification?.status === "no_changes"
          ? "No workspace changes were detected; repository checks were not run."
          : undefined;
      const knownIssues = [
        this.currentTaskReason,
        verificationReason,
        ...failedChecks.map((check) => `${check.command}: ${check.output}`),
        ...this.currentToolFailures.map((failure) => `${failure.tool}: ${failure.message}`),
        inspection.error,
      ].filter((issue): issue is string => Boolean(issue));
      const nextAction = completionNextAction(status);
      const report = {
        schemaVersion: "task-report-v1",
        taskId: task.id,
        status,
        provider: this.provider.name,
        model: config.model,
        durationMs: Math.max(0, Date.now() - input.startedAt),
        usage: {
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          totalTokens: usage ? usage.inputTokens + usage.outputTokens : null,
          estimatedCostUsd: usage && this.hasPricing
            ? this.estimateCost(usage.inputTokens, usage.outputTokens)
            : null,
        },
        fingerprints: {
          systemPromptSha256: input.promptFingerprint ?? null,
          configSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
        },
        changedFiles: changedFiles.map((path) => ({ path, risk: classifyFileRisk(path) })),
        baselineChecks: input.baselineChecks.map((check) => ({
          command: check.command,
          passed: check.passed,
          baseline: check.baseline,
        })),
        verification: {
          status: input.verification?.status ?? "not_run",
          reason: verificationReason ?? null,
          checks: input.verification && "checks" in input.verification
            ? (input.verification.checks ?? []).map((check) => ({
                command: check.command,
                passed: check.passed,
                baseline: check.baseline,
                output: check.output,
              }))
            : [],
          skippedChecks: input.verification && "skippedChecks" in input.verification
            ? input.verification.skippedChecks
            : input.verification?.status === "no_changes"
              ? ["Repository checks were not run because no task-owned workspace changes were detected."]
              : ["Finish verification gate was not reached."],
        },
        currentPlan: plan ? {
          title: plan.title,
          currentStep: currentStep?.description ?? null,
          steps: plan.steps,
        } : null,
        toolFailures: this.currentToolFailures,
        knownIssues,
        nextAction,
      };
      await this.publishStructured(task.id, "evidence", report);
      await this.publish(task.id, "status", renderCompletionReport(report));
    } catch (error) {
      console.error(
        `Unable to create completion report for task ${task.id}: ${error instanceof Error ? error.message : "Unknown reporting error"}`,
      );
    }
  }

}

interface CompletionReportView {
  status: TaskStatus;
  changedFiles: Array<{ path: string; risk: string }>;
  verification: {
    status: string;
    reason: string | null;
    checks: Array<{ command: string; passed: boolean; baseline: string; output: string }>;
    skippedChecks: string[];
  };
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; estimatedCostUsd: number | null };
  knownIssues: string[];
  nextAction: string;
}

function completionNextAction(status: TaskStatus): string {
  switch (status) {
    case TaskStatus.DONE: return "Review the diff and verification evidence before merging or delivering.";
    case TaskStatus.UNVERIFIED: return "Review the listed verification gap, then run the missing checks or ask for clarification.";
    case TaskStatus.PAUSED: return "Inspect the partial work and task reason; resume only after addressing the pause condition.";
    case TaskStatus.CANCELLED: return "Review partial changes; create a new task or resume only if the task is explicitly paused.";
    case TaskStatus.FAILED: return "Review the failure details and partial diff, then fix the cause before starting another task.";
    case TaskStatus.PENDING: return "Wait for the task to start and inspect its activity.";
    case TaskStatus.RUNNING: return "Inspect current task activity; the task has not reached a terminal state.";
  }
}

function formatDeliveryEvidence(outcome: Extract<VerificationOutcome, { status: "passed" }>): string {
  return [
    `Verification status: ${outcome.status}`,
    ...outcome.checks.map((check) =>
      `- PASS ${check.command} (exit 0; baseline ${check.baseline})`,
    ),
    `Changed files: ${outcome.changedFiles.join(", ")}`,
  ].join("\n");
}

function classifyFileRisk(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)\.env(?:$|\.)/.test(normalized) || /\.(?:pem|p12|pfx|key)$/.test(normalized)) return "restricted";
  if (
    normalized === "package.json" ||
    normalized.endsWith("/package.json") ||
    normalized.startsWith(".github/workflows/") ||
    /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.test|\.spec)\./.test(normalized) ||
    /(?:tsconfig|jest|vitest|eslint|playwright|turbo)\.[^/]+$/.test(normalized)
  ) return "high";
  if (/\.(?:md|mdx|txt)$/i.test(normalized)) return "low";
  return "medium";
}

function renderCompletionReport(report: CompletionReportView): string {
  const lines = [
    "Task completion report",
    `Status: ${report.status}`,
    `Changed files: ${report.changedFiles.length ? report.changedFiles.map((file) => `${file.path} (${file.risk} risk)`).join(", ") : "none detected"}`,
    `Verification: ${report.verification.status}`,
  ];
  if (report.verification.checks.length) {
    lines.push("Checks:");
    for (const check of report.verification.checks) {
      lines.push(`- ${check.passed ? "PASS" : "FAIL"} ${check.command} (baseline ${check.baseline})`);
    }
  }
  if (report.verification.skippedChecks.length) {
    lines.push("Skipped/unavailable checks:");
    for (const check of report.verification.skippedChecks) lines.push(`- ${check}`);
  }
  if (report.verification.reason) lines.push(`Verification note: ${report.verification.reason}`);
  lines.push(`Usage: ${report.usage.totalTokens === null
    ? "unavailable"
    : `${report.usage.inputTokens} input + ${report.usage.outputTokens} output = ${report.usage.totalTokens} tokens`}`);
  lines.push(`Estimated cost: ${report.usage.estimatedCostUsd === null ? "not configured" : `$${report.usage.estimatedCostUsd.toFixed(6)}`}`);
  if (report.knownIssues.length) {
    lines.push("Known issues:");
    for (const issue of report.knownIssues) lines.push(`- ${issue}`);
  } else {
    lines.push("Known issues: none recorded");
  }
  lines.push(`Next action: ${report.nextAction}`);
  return lines.join("\n");
}

function verificationFailureSummary(outcome: Extract<VerificationOutcome, { status: "failed" }>): string {
  const summary = outcome.checks
    .filter((check) => !check.passed && check.baseline !== "failed")
    .map((check) => `${check.command}: ${check.output}`)
    .join("\n");
  const maxChars = 24_000;
  if (summary.length <= maxChars) return summary;
  return `[Verification failure details truncated]\n${summary.slice(-maxChars)}`;
}

function verificationRepairPrompt(
  outcome: Extract<VerificationOutcome, { status: "failed" }>,
  attempt: number,
  maxAttempts: number,
): string {
  return [
    `The repository verification gate failed. This is repair attempt ${attempt} of ${maxAttempts}.`,
    `Changed files: ${outcome.changedFiles.join(", ")}`,
    "Fix the failing checks, then provide a concise completion response. Do not claim success unless verification passes.",
    verificationFailureSummary(outcome),
  ].join("\n\n");
}