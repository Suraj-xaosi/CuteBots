import { ErrorCode, type Result } from "@workspace/types";
import type { HumanInteraction } from "../tools/ask-human-tool.js";
import type { AgentChannel, AgentLogEvent, AgentPersistence } from "../agent/agent-types.js";
import { HumanReplyInbox } from "./human-reply-inbox.js";
import { SSEBroker } from "./sse-broker.js";

export class UIChannel implements AgentChannel, HumanInteraction {
  constructor(
    private readonly taskId: string,
    private readonly persistence: AgentPersistence,
    private readonly sseBroker: SSEBroker,
    private readonly replies: HumanReplyInbox,
  ) {}

  async sendMessage(text: string): Promise<void> {
    const saved = await this.persistence.appendLog({ taskId: this.taskId, type: "message", content: text });
    if (!saved.ok) throw new Error(saved.error);
    this.sseBroker.publish(saved.data);
  }

  async sendLog(event: AgentLogEvent): Promise<void> {
    this.sseBroker.publish(event);
  }

  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    return this.replies.waitForReply(this.taskId, timeoutMs, signal);
  }

  async ask(question: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    const waitController = new AbortController();
    const onAbort = () => waitController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const reply = this.waitForReply(timeoutMs, waitController.signal);
    try {
      await this.sendMessage(question);
    } catch (error) {
      waitController.abort();
      await reply.catch(() => undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to send question to UI",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
    try {
      return await reply;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}