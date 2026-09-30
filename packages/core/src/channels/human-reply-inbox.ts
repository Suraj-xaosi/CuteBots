import { ErrorCode, type Result } from "@workspace/types";

interface PendingReply {
  resolve: (result: Result<string>) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class HumanReplyInbox {
  private readonly waiters = new Map<string, PendingReply>();

  waitForReply(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string>> {
    if (this.waiters.has(taskId)) {
      return Promise.resolve({ ok: false, error: "A human reply is already pending", code: ErrorCode.TASK_ALREADY_RUNNING });
    }
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, error: "Human reply wait was cancelled", code: ErrorCode.TASK_CANCELLED });
    }

    return new Promise((resolve) => {
      const waiter: PendingReply = {
        resolve,
        timeout: setTimeout(() => {
          this.finish(taskId, { ok: false, error: "Human reply timed out", code: ErrorCode.TASK_TIMEOUT });
        }, Math.max(0, timeoutMs)),
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          this.finish(taskId, { ok: false, error: "Human reply wait was cancelled", code: ErrorCode.TASK_CANCELLED });
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.set(taskId, waiter);
    });
  }

  submit(taskId: string, reply: string): Result<void> {
    const normalizedReply = reply.trim();
    if (!normalizedReply) {
      return { ok: false, error: "Reply cannot be empty", code: ErrorCode.TOOL_EXECUTION_FAILED };
    }
    const waiter = this.waiters.get(taskId);
    if (waiter) {
      this.finish(taskId, { ok: true, data: normalizedReply });
      return { ok: true, data: undefined };
    }
    return { ok: false, error: "Task is not waiting for a human reply", code: ErrorCode.TASK_NOT_FOUND };
  }

  private finish(taskId: string, result: Result<string>): void {
    const waiter = this.waiters.get(taskId);
    if (!waiter) return;
    this.waiters.delete(taskId);
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(result);
  }
}