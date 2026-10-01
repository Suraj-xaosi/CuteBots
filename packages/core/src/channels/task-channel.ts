import { ErrorCode, type Result } from "@workspace/types";
import type { AgentChannel, AgentLogEvent } from "../agent/agent-types.js";
import type { HumanInteraction } from "../tools/ask-human-tool.js";
import type { TelegramChannel } from "./telegram-channel.js";
import type { UIChannel } from "./ui-channel.js";

export class TaskChannel implements AgentChannel, HumanInteraction {
  constructor(
    private readonly ui: UIChannel,
    private readonly telegram: TelegramChannel,
  ) {}

  async sendMessage(text: string): Promise<void> {
    await this.ui.sendMessage(text);
    if (this.telegram.isReady) await this.telegram.sendMessage(text);
  }

  async sendLog(event: AgentLogEvent): Promise<void> {
    await this.ui.sendLog(event);
    if (this.telegram.isReady && ["status", "warn", "error"].includes(event.type)) {
      await this.telegram.sendLog(event);
    }
  }

  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    return this.ui.waitForReply(timeoutMs, signal);
  }

  async ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    const waitController = new AbortController();
    const onAbort = () => waitController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const reply = this.waitForReply(timeoutMs, waitController.signal);
    const telegramWaiting = this.telegram.beginWaitingForReply();
    try {
      const telegramNote = this.telegram.isReady && !telegramWaiting
        ? " (Telegram is waiting for another task; reply in the dashboard.)"
        : "";
      await this.ui.sendMessage(`${question}${telegramNote}`);
      if (telegramWaiting) await this.telegram.sendMessage(`CuteBots needs your input:\n${question}`);
      return await reply;
    } catch (error) {
      waitController.abort();
      await reply.catch(() => undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to deliver the question",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    } finally {
      this.telegram.endWaitingForReply();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
