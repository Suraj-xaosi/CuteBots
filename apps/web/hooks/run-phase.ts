import { AgentRunStatus, type AgentRunStatusValue } from "@workspace/types"

// ---------------------------------------------------------------------------
// RUN PHASE: the status words turned into what the SCREEN needs to know.
//
// The server has 7 statuses. The screen only cares about 7 situations, and
// every component must read the same answer, so it lives here, in one place.
// Pure function: no React, easy to test.
//
//   status               phase      composer          strip above composer
//   (no run yet)         none       open              nothing
//   QUEUED               starting   CLOSED            "Starting..."  + Stop
//   RUNNING              working    CLOSED            "Working..."   + Stop
//   AWAITING_APPROVAL    working    CLOSED            "Working..."   + Stop
//   WAITING_FOR_INPUT    waiting    open (as Reply)   "Waiting for your reply" + Stop
//   DONE                 done       open              nothing
//   FAILED               failed     open              error + reason
//   INTERRUPTED          stopped    open              "Run was stopped" (not an error)
// ---------------------------------------------------------------------------
export type RunPhase =
  | "none"
  | "starting"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"

export function phaseOf(status: AgentRunStatusValue | null | undefined): RunPhase {
  switch (status) {
    case AgentRunStatus.QUEUED:
      return "starting"
    case AgentRunStatus.RUNNING:
    case AgentRunStatus.AWAITING_APPROVAL:
      return "working"
    case AgentRunStatus.WAITING_FOR_INPUT:
      return "waiting"
    case AgentRunStatus.DONE:
      return "done"
    case AgentRunStatus.FAILED:
      return "failed"
    case AgentRunStatus.INTERRUPTED:
      return "stopped"
    default:
      return "none"
  }
}

// The agent owns the project right now, so a new message would be refused by
// the server ("already working"). The composer is closed instead.
export function blocksComposer(phase: RunPhase): boolean {
  return phase === "starting" || phase === "working"
}

// A run is alive and can be stopped.
export function canStop(phase: RunPhase): boolean {
  return phase === "starting" || phase === "working" || phase === "waiting"
}