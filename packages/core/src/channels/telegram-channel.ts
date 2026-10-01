import { Telegraf } from "telegraf";
import { ErrorCode, type Result } from "@workspace/types";
import type { HumanInteraction } from "../tools/ask-human-tool.js";
import type { AgentChannel, AgentLogEvent } from "../agent/agent-types.js";
import { HumanReplyInbox } from "./human-reply-inbox.js";

export interface TelegramGatewayOptions {
  botToken?: string;
  chatId?: string;
  onChatIdChanged?: (chatId: string) => Promise<Result<void>>;
}

export class TelegramGateway {
  private bot: Telegraf | undefined;
  private chatId: string | undefined;
  private botToken: string | undefined;
  private readonly activeTasksByChat = new Map<string, string>();
  private readonly onChatIdChanged: TelegramGatewayOptions["onChatIdChanged"];

  constructor(
    options: TelegramGatewayOptions,
    private readonly replies: HumanReplyInbox,
  ) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.onChatIdChanged = options.onChatIdChanged;
  }

  async start(): Promise<Result<void>> {
    if (!this.botToken) return { ok: true, data: undefined };
    if (this.bot) return { ok: true, data: undefined };

    const bot = new Telegraf(this.botToken);
    bot.start(async (context) => {
      const chatId = String(context.chat.id);
      if (this.chatId && this.chatId !== chatId) {
        await context.reply("This CuteBots bot is already paired with another chat.");
        return;
      }
      const saved = await this.onChatIdChanged?.(chatId);
      if (saved && !saved.ok) {
        await context.reply(`Couldn't save this pairing: ${saved.error}`);
        return;
      }
      this.chatId = chatId;
      await context.reply("CuteBots is connected. Task updates and questions will appear here.");
    });
    bot.on("text", async (context) => {
      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(context.message.text)) return;
      const chatId = String(context.chat.id);
      if (!this.chatId || this.chatId !== chatId) {
        await context.reply("Send /start in the paired chat to connect CuteBots.");
        return;
      }
      const taskId = this.activeTasksByChat.get(chatId);
      if (!taskId) return;
      const submitted = this.replies.submit(taskId, context.message.text);
      if (submitted.ok) await context.reply("Reply received.");
    });
    bot.catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown Telegram error";
      console.error("Telegram update failed:", redactToken(message, this.botToken));
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

  async configure(botToken: string | undefined): Promise<Result<void>> {
    if (botToken === this.botToken) return this.start();
    this.stop();
    this.botToken = botToken?.trim() || undefined;
    this.chatId = undefined;
    const unpaired = await this.onChatIdChanged?.("");
    if (unpaired && !unpaired.ok) return unpaired;
    return this.start();
  }

  stop(): void {
    this.bot?.stop("settings changed");
    this.bot = undefined;
    this.activeTasksByChat.clear();
  }

  get isReady(): boolean {
    return Boolean(this.bot && this.chatId);
  }

  beginWaitingForReply(taskId: string): boolean {
    if (!this.isReady || !this.chatId) return false;
    const activeTask = this.activeTasksByChat.get(this.chatId);
    if (activeTask && activeTask !== taskId) return false;
    this.activeTasksByChat.set(this.chatId, taskId);
    return true;
  }

  endWaitingForReply(taskId: string): void {
    if (this.chatId && this.activeTasksByChat.get(this.chatId) === taskId) {
      this.activeTasksByChat.delete(this.chatId);
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    for (const chunk of splitTelegramMessage(text)) {
      await this.bot.telegram.sendMessage(this.chatId, chunk);
    }
  }

  async waitForReply(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    if (!this.botToken || !this.bot) {
      return { ok: false, error: "Telegram is disabled", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }
    if (!this.chatId) {
      return { ok: false, error: "Send /start to the Telegram bot before asking for input", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }

    if (!this.beginWaitingForReply(taskId)) {
      return {
        ok: false,
        error: "Another task is already waiting for a Telegram reply; reply to it first or use the dashboard",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
    try {
      return await this.replies.waitForReply(taskId, timeoutMs, signal);
    } finally {
      this.endWaitingForReply(taskId);
    }
  }
}

export class TelegramChannel implements AgentChannel, HumanInteraction {
  constructor(
    private readonly taskId: string,
    private readonly gateway: TelegramGateway,
  ) {}

  get isReady(): boolean {
    return this.gateway.isReady;
  }

  beginWaitingForReply(): boolean {
    return this.gateway.beginWaitingForReply(this.taskId);
  }

  endWaitingForReply(): void {
    this.gateway.endWaitingForReply(this.taskId);
  }

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

function splitTelegramMessage(text: string, maxLength = 4_000): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function redactToken(message: string, token: string | undefined): string {
  return token ? message.split(token).join("[redacted]") : message;
}