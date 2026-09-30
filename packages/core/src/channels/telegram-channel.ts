import { Telegraf } from "telegraf";
import { ErrorCode, type Result } from "@workspace/types";
import type { HumanInteraction } from "../tools/ask-human-tool.js";
import type { AgentChannel, AgentLogEvent } from "../agent/agent-types.js";
import { HumanReplyInbox } from "./human-reply-inbox.js";

export interface TelegramGatewayOptions {
  botToken?: string;
  chatId?: string;
}

export class TelegramGateway {
  private bot: Telegraf | undefined;
  private chatId: string | undefined;
  private readonly activeTasksByChat = new Map<string, string>();

  constructor(
    private readonly options: TelegramGatewayOptions,
    private readonly replies: HumanReplyInbox,
  ) {
    this.chatId = options.chatId;
  }

  async start(): Promise<Result<void>> {
    if (!this.options.botToken) return { ok: true, data: undefined };
    if (this.bot) return { ok: true, data: undefined };

    const bot = new Telegraf(this.options.botToken);
    bot.start(async (context) => {
      this.chatId ??= String(context.chat.id);
      await context.reply("CuteBots is connected. Task updates will appear here.");
    });
    bot.on("text", async (context) => {
      const chatId = String(context.chat.id);
      this.chatId ??= chatId;
      const taskId = this.activeTasksByChat.get(chatId);
      if (!taskId) return;
      const submitted = this.replies.submit(taskId, context.message.text);
      if (submitted.ok) await context.reply("Reply received.");
    });

    try {
      await bot.launch();
      this.bot = bot;
      return { ok: true, data: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Telegram bot failed to start",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
  }

  stop(): void {
    this.bot?.stop("SIGTERM");
    this.bot = undefined;
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    await this.bot.telegram.sendMessage(this.chatId, text);
  }

  async waitForReply(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    if (!this.options.botToken || !this.bot) {
      return { ok: false, error: "Telegram is disabled", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }
    if (!this.chatId) {
      return { ok: false, error: "Send /start to the Telegram bot before asking for input", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }

    this.activeTasksByChat.set(this.chatId, taskId);
    try {
      return await this.replies.waitForReply(taskId, timeoutMs, signal);
    } finally {
      if (this.activeTasksByChat.get(this.chatId) === taskId) this.activeTasksByChat.delete(this.chatId);
    }
  }
}

export class TelegramChannel implements AgentChannel, HumanInteraction {
  constructor(
    private readonly taskId: string,
    private readonly gateway: TelegramGateway,
  ) {}

  sendMessage(text: string): Promise<void> {
    return this.gateway.sendMessage(text);
  }

  sendLog(event: AgentLogEvent): Promise<void> {
    return this.gateway.sendMessage(`[${event.type}] ${event.content}`);
  }

  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    return this.gateway.waitForReply(this.taskId, timeoutMs, signal);
  }

  async ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    if (!this.gateway) {
      return { ok: false, error: "Telegram is disabled", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }
    const waitController = new AbortController();
    const onAbort = () => waitController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const reply = this.waitForReply(timeoutMs, waitController.signal);
    try {
      await this.gateway.sendMessage(question);
      return await reply;
    } catch (error) {
      waitController.abort();
      await reply.catch(() => undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to send Telegram question",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}