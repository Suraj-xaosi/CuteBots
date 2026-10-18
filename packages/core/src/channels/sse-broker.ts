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

  async subscribeEvents(
    taskId: string,
    onEvent: (event: AgentLogEvent) => void,
    afterId = 0,
    onError: (error: string) => void = () => {},
  ): Promise<() => void> {
    let closed = false;
    let onClose = () => {};
    const client: SSEClient = {
      get writableEnded() {
        return closed;
      },
      get destroyed() {
        return closed;
      },
      write(chunk) {
        const eventName = chunk.match(/^event: ([^\r\n]+)/m)?.[1];
        const data = chunk.match(/^data: (.+)$/m)?.[1];
        if (!data) return false;
        let payload: unknown;
        try {
          payload = JSON.parse(data) as unknown;
        } catch {
          onError("Task stream returned invalid event data");
          return false;
        }
        if (eventName === "stream_error") {
          const message = isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Task stream failed";
          onError(message);
          return false;
        }
        if (isAgentLogEvent(payload, taskId)) onEvent(payload);
        return true;
      },
      on(_event, listener) {
        onClose = listener;
      },
    };

    await this.subscribe(taskId, client, afterId);
    return () => {
      if (closed) return;
      closed = true;
      onClose();
    };
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

  private send(subscriber: Subscriber, event: AgentLogEvent) {
    if (isClosed(subscriber) || event.id <= subscriber.lastSentId) return;
    subscriber.client.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    subscriber.lastSentId = event.id;
  }
}

function isAgentLogEvent(value: unknown, taskId: string): value is AgentLogEvent {
  return isRecord(value)
    && value.taskId === taskId
    && Number.isSafeInteger(value.id)
    && typeof value.type === "string"
    && typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function isClosed(subscriber: Subscriber) {
  return subscriber.closed || subscriber.client.writableEnded || subscriber.client.destroyed === true;
}