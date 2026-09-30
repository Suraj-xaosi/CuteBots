import { ErrorCode, type Result } from "@workspace/types";
import type { AgentLogEvent, AgentPersistence } from "../agent/agent-types.js";

const REPLAY_PAGE_SIZE = 200;

export interface SSEClient {
  readonly writableEnded: boolean;
  readonly destroyed?: boolean;
  write(chunk: string): unknown;
  on(event: "close", listener: () => void): unknown;
}

interface Subscriber {
  client: SSEClient;
  lastSentId: number;
  replaying: boolean;
  buffered: AgentLogEvent[];
  closed: boolean;
}

export class SSEBroker {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly persistence: Pick<AgentPersistence, "listLogsAfter">) {}

  async subscribe(taskId: string, client: SSEClient, afterId = 0): Promise<void> {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || client.writableEnded) return;

    const subscriber: Subscriber = {
      client,
      lastSentId: afterId,
      replaying: true,
      buffered: [],
      closed: false,
    };
    const taskSubscribers = this.subscribers.get(taskId) ?? new Set<Subscriber>();
    taskSubscribers.add(subscriber);
    this.subscribers.set(taskId, taskSubscribers);

    const unsubscribe = () => {
      subscriber.closed = true;
      taskSubscribers.delete(subscriber);
      if (taskSubscribers.size === 0) this.subscribers.delete(taskId);
    };
    client.on("close", unsubscribe);

    let cursor = afterId;
    try {
      while (!isClosed(subscriber)) {
        const page = await this.persistence.listLogsAfter(taskId, cursor, REPLAY_PAGE_SIZE);
        if (!page.ok) {
          client.write(`event: stream_error\ndata: ${JSON.stringify({ error: page.error })}\n\n`);
          unsubscribe();
          return;
        }
        const events = page.data.slice().sort((left, right) => left.id - right.id);
        for (const event of events) {
          this.send(subscriber, event);
          cursor = Math.max(cursor, event.id);
          if (isClosed(subscriber)) break;
        }
        if (events.length < REPLAY_PAGE_SIZE) break;
      }

      subscriber.buffered.sort((left, right) => left.id - right.id);
      for (const event of subscriber.buffered) this.send(subscriber, event);
      subscriber.buffered = [];
      subscriber.replaying = false;
      if (isClosed(subscriber)) unsubscribe();
    } catch (error) {
      unsubscribe();
      if (!isClosed(subscriber)) {
        client.write(`event: stream_error\ndata: ${JSON.stringify({
          error: error instanceof Error ? error.message : "Unable to replay task logs",
        })}\n\n`);
      }
    }
  }

  publish(event: AgentLogEvent): void {
    const subscribers = this.subscribers.get(event.taskId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      if (subscriber.replaying) {
        subscriber.buffered.push(event);
      } else {
        this.send(subscriber, event);
      }
    }
  }

  private send(subscriber: Subscriber, event: AgentLogEvent): void {
    if (isClosed(subscriber) || event.id <= subscriber.lastSentId) return;
    subscriber.client.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    subscriber.lastSentId = event.id;
  }
}

export function parseLastEventId(value: string | undefined): Result<number> {
  if (value === undefined || value === "") return { ok: true, data: 0 };
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: "Last-Event-ID must be a non-negative integer", code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: "Last-Event-ID is outside the supported range", code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  return { ok: true, data: id };
}

function isClosed(subscriber: Subscriber): boolean {
  return subscriber.closed || subscriber.client.writableEnded || subscriber.client.destroyed === true;
}