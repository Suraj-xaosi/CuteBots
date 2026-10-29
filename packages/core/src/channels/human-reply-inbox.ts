import { ErrorCode, type Result } from "@workspace/types"

interface PendingReply {
  resolve: (result: Result<string>) => void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export class HumanReplyInbox {
  private readonly waiters = new Map<string, PendingReply>()

  waitForReply(
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Result<string>> {
    if (this.waiters.has(runId)) {
      return Promise.resolve({
        ok: false,
        error: "A human reply is already pending for this run",
        code: ErrorCode.TASK_ALREADY_RUNNING,
      })
    }

    if (signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: "Human reply wait was cancelled",
        code: ErrorCode.TASK_CANCELLED,
      })
    }

    return new Promise((resolve) => {
      const waiter: PendingReply = {
        resolve,
        timeout: setTimeout(
          () => {
            this.finish(runId, {
              ok: false,
              error: "Human reply timed out",
              code: ErrorCode.TASK_TIMEOUT,
            })
          },
          Math.max(0, timeoutMs)
        ),
        signal,
      }

      if (signal) {
        waiter.onAbort = () => {
          this.finish(runId, {
            ok: false,
            error: "Human reply wait was cancelled",
            code: ErrorCode.TASK_CANCELLED,
          })
        }

        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }

      this.waiters.set(runId, waiter)

      if (signal?.aborted) {
        waiter.onAbort?.()
      }
    })
  }

  submit(runId: string, reply: string): Result<void> {
    const normalizedReply = reply.trim()
    if (!normalizedReply) {
      return {
        ok: false,
        error: "Reply cannot be empty",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }

    if (!this.waiters.has(runId)) {
      return {
        ok: false,
        error: "Run is not waiting for a human reply",
        code: ErrorCode.TASK_NOT_FOUND,
      }
    }

    this.finish(runId, { ok: true, data: normalizedReply })
    return { ok: true, data: undefined }
  }

  private finish(runId: string, result: Result<string>): void {
    const waiter = this.waiters.get(runId)
    if (!waiter) return

    this.waiters.delete(runId)
    clearTimeout(waiter.timeout)

    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
    }

    waiter.resolve(result)
  }
}
