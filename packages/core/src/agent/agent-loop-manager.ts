import { ErrorCode, type Result } from "@workspace/types"
import type { AgentExecutor, AgentRunContext } from "./agent-types.js"

export type AgentExecutorFactory = (context: AgentRunContext) => AgentExecutor

export class AgentLoopManager {
  private static instance: AgentLoopManager | undefined

  private readonly projects = new Map<
    string,
    { runId: string; executor: AgentExecutor }
  >()

  private constructor(private readonly createExecutor: AgentExecutorFactory) {}

  static getInstance(createExecutor?: AgentExecutorFactory): AgentLoopManager {
    if (!this.instance) {
      if (!createExecutor) {
        throw new Error(
          "AgentLoopManager must be initialized with an executor factory"
        )
      }

      this.instance = new AgentLoopManager(createExecutor)
    }

    return this.instance
  }

  start(context: AgentRunContext): Result<void> {
    const runAlreadyActive = [...this.projects.values()].some(
      (active) => active.runId === context.runId
    )

    if (runAlreadyActive) {
      return {
        ok: false,
        error: `Agent run ${context.runId} is already active`,
        code: ErrorCode.TASK_ALREADY_RUNNING,
      }
    }

    if (this.projects.has(context.projectId)) {
      return {
        ok: false,
        error: "This project already has an active agent run",
        code: ErrorCode.TASK_ALREADY_RUNNING,
      }
    }

    let executor: AgentExecutor

    try {
      executor = this.createExecutor(context)
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to create the agent executor",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }

    this.projects.set(context.projectId, { runId: context.runId, executor })

    void Promise.resolve()
      .then(() => executor.run(context))
      .catch((error: unknown) => {
        console.error(`Agent run ${context.runId} failed:`, error)
      })
      .finally(() => {
        const active = this.projects.get(context.projectId)
        if (active?.runId === context.runId) {
          this.projects.delete(context.projectId)
        }
      })

    return { ok: true, data: undefined }
  }
  async cancel(runId: string): Promise<Result<void>> {
    for (const active of this.projects.values()) {
      if (active.runId === runId) {
        active.executor.stop()
        return { ok: true, data: undefined }
      }
    }

    return {
      ok: false,
      error: `Agent run ${runId} is not active`,
      code: ErrorCode.TASK_NOT_FOUND,
    }
  }
}
