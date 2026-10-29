import type { AgentRunLogEvent, Result } from '@workspace/types'
import { ErrorCode } from '@workspace/types'
import type { AgentRunPersistence } from '@workspace/core'

const REPLAY_PAGE_SIZE = 200

interface Subscriber {
  onEvent: (event: AgentRunLogEvent) => void
  onError: (message: string) => void
  lastSentId: number
  replaying: boolean
  buffered: AgentRunLogEvent[]
  closed: boolean
  unsubscribe: () => void
}

export class RunEventBroker {
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  constructor(
    private readonly persistence: Pick<AgentRunPersistence, 'listRunLogsAfter'>
  ) {}

  subscribe(
    runId: string,
    onEvent: (event: AgentRunLogEvent) => void,
    afterId: number,
    onError: (message: string) => void
  ) {
    const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>()

    const subscriber: Subscriber = {
      onEvent,
      onError,
      lastSentId: afterId,
      replaying: true,
      buffered: [],
      closed: false,
      unsubscribe: () => {
        subscriber.closed = true
        runSubscribers.delete(subscriber)
        if (runSubscribers.size === 0) this.subscribers.delete(runId)
      },
    }

    runSubscribers.add(subscriber)
    this.subscribers.set(runId, runSubscribers)

    void this.replay(runId, subscriber, afterId)
    return subscriber.unsubscribe
  }

  publish(event: AgentRunLogEvent): void {
    const subscribers = this.subscribers.get(event.runId)
    if (!subscribers) return

    for (const subscriber of subscribers) {
      if (subscriber.replaying) subscriber.buffered.push(event)
      else this.send(subscriber, event)
    }
  }

  private async replay(
    runId: string,
    subscriber: Subscriber,
    afterId: number
  ): Promise<void> {
    let cursor = afterId

    while (!subscriber.closed) {
      try {
        const page = await this.persistence.listRunLogsAfter(
          runId,
          cursor,
          REPLAY_PAGE_SIZE
        )

        if (subscriber.closed) return
        if (!page.ok) {
          const message = 'error' in page ? page.error : 'Replay failed'
          this.fail(subscriber, message)
          return
        }

        const events = page.data.slice().sort((left, right) => left.id - right.id)
        for (const event of events) {
          this.send(subscriber, event)
          cursor = Math.max(cursor, event.id)
          if (subscriber.closed) return
        }

        if (events.length < REPLAY_PAGE_SIZE) break
      } catch (error) {
        this.fail(subscriber, error instanceof Error ? error.message : 'Replay failed')
        return
      }
    }

    subscriber.buffered.sort((left, right) => left.id - right.id)

    for (const event of subscriber.buffered) {
      this.send(subscriber, event)
      if (subscriber.closed) return
    }

    subscriber.buffered = []
    subscriber.replaying = false
  }

  private send(subscriber: Subscriber, event: AgentRunLogEvent): void {
    if (subscriber.closed || event.id <= subscriber.lastSentId) return
    subscriber.onEvent(event)
    subscriber.lastSentId = event.id
  }

  private fail(subscriber: Subscriber, message: string): void {
    subscriber.unsubscribe()
    subscriber.onError(message)
  }
}

export function parseLastEventId(value: string | undefined): Result<number> {
  if (value === undefined || value === '') return { ok: true, data: 0 }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      error: 'Last event id is invalid',
      code: ErrorCode.TOOL_EXECUTION_FAILED,
    }
  }

  return { ok: true, data: parsed }
}
