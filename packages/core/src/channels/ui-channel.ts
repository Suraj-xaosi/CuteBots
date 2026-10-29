import { ErrorCode, type Result } from "@workspace/types";
import type { HumanInteraction } from "../tools/ask-human-tool.js";
import type {
  AgentChannel,
  AgentRunLogEvent,
  AgentRunPersistence,
} from "../agent/agent-types.js";
import { HumanReplyInbox } from "./human-reply-inbox.js";

export class UIChannel implements AgentChannel, HumanInteraction {
  constructor(
    private readonly runId: string,
    private readonly persistence: AgentRunPersistence,
    private readonly publishRunEvent: (event: AgentRunLogEvent) => void,
    private readonly replies: HumanReplyInbox,
  ) {}

  async sendMessage(text: string): Promise<void> {
    const saved = await this.persistence.appendRunLog({
      runId: this.runId,
      type: "message",
      content: text,
    });

    if (!saved.ok) throw new Error(saved.error);
    this.publishRunEvent(saved.data);
  }

  async sendLog(event: AgentRunLogEvent): Promise<void> {
    this.publishRunEvent(event);
  }

  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    return this.replies.waitForReply(this.runId, timeoutMs, signal);
  }

  async ask(
    question: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<string>> {
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
        error:
          error instanceof Error
            ? error.message
            : "Unable to send question to UI",
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