import express, { type Router } from "express";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { z } from "zod";
import { SSEBroker, type AgentLogEvent } from "@workspace/core";
import type { TaskService } from "../services/task-service.js";
import { parseId, parseRequest } from "../http/validation.js";

const replySchema = z.object({ reply: z.string().trim().min(1).max(20_000) }).strict();
const continuationSchema = z.object({ continuation: z.string().trim().min(1).max(20_000) }).strict();
const chatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    parts: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    }).passthrough()),
  }).passthrough()).min(1).max(1),
  watch: z.boolean().optional(),
  afterId: z.number().int().nonnegative().optional(),
}).passthrough();

type ChatMessage = UIMessage<never, { taskEvent: AgentLogEvent }>;

export function createTaskRouter(tasks: TaskService, sseBroker: SSEBroker): Router {
  const router = express.Router();

  router.get("/:taskId/messages", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    response.status(200).json({ messages: await tasks.messages(taskId) });
  });

  router.post("/:taskId/chat", async (request, response, next) => {
    try {
      const taskId = parseId(request.params.taskId, "task id");
      const body = parseRequest(chatRequestSchema, request.body);
      let afterId = body.afterId ?? 0;

      if (body.watch) {
        await tasks.assertExists(taskId);
      } else {
        const continuation = latestUserMessage(body.messages);
        if (!continuation) {
          response.status(400).json({ error: "A non-empty user message is required" });
          return;
        }
        afterId = await tasks.continueChat(taskId, continuation);
      }

      const messageId = `task-${taskId}-${Date.now()}`;
      let stopListening = () => {};
      const stream = createUIMessageStream<ChatMessage>({
        execute: async ({ writer }) => {
          writer.write({ type: "start", messageId });
          let textStarted = false;
          let ended = false;
          let closeSubscription: (() => void) | undefined;
          let resolveFinished!: () => void;
          const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
          });
          const finish = () => {
            if (ended) return;
            ended = true;
            if (textStarted) writer.write({ type: "text-end", id: messageId });
            writer.write({ type: "finish", finishReason: "stop" });
            closeSubscription?.();
            resolveFinished();
          };
          const startText = () => {
            if (textStarted) return;
            writer.write({ type: "text-start", id: messageId });
            textStarted = true;
          };

          const unsubscribe = await sseBroker.subscribeEvents(
            taskId,
            (event) => {
              if (event.type === "assistant_delta") {
                startText();
                writer.write({ type: "text-delta", id: messageId, delta: event.content });
              } else {
                writer.write({ type: "data-taskEvent", id: String(event.id), data: event });
                if (event.type === "message" && !textStarted && event.content) {
                  startText();
                  writer.write({ type: "text-delta", id: messageId, delta: event.content });
                }
                if (isTerminalEvent(event)) finish();
              }
            },
            afterId,
            (error) => {
              writer.write({ type: "error", errorText: error });
              finish();
            },
          );
          closeSubscription = unsubscribe;
          stopListening = () => {
            unsubscribe();
            finish();
          };
          if (ended) unsubscribe();
          if (response.destroyed) stopListening();
          await finished;
        },
        onError: (error) => error instanceof Error ? error.message : "Task chat stream failed",
      });
      const uiResponse = createUIMessageStreamResponse({ stream, keepAliveMs: 15_000 });
      response.status(uiResponse.status);
      uiResponse.headers.forEach((value, key) => response.setHeader(key, value));
      if (!uiResponse.body) throw new Error("Task chat stream has no response body");
      const onClose = () => stopListening();
      response.once("close", onClose);

      const reader = uiResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (response.destroyed) break;
          if (!response.write(value)) {
            await new Promise<void>((resolve) => {
              const resume = () => {
                response.off("drain", resume);
                response.off("close", resume);
                resolve();
              };
              response.once("drain", resume);
              response.once("close", resume);
            });
          }
        }
        if (!response.destroyed) response.end();
      } finally {
        response.off("close", onClose);
        reader.releaseLock();
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      next(error);
    }
  });

  router.post("/:taskId/reply", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    const { reply } = parseRequest(replySchema, request.body);
    await tasks.reply(taskId, reply);
    response.status(200).json({ status: "received" });
  });

  router.post("/:taskId/cancel", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    await tasks.cancel(taskId);
    response.status(200).json({ status: "cancellation requested" });
  });

  router.post("/:taskId/resume", async (request, response) => {
    const taskId = parseId(request.params.taskId, "task id");
    const { continuation } = parseRequest(continuationSchema, request.body);
    const result = await tasks.resume(taskId, continuation);
    response.status(202).json(result);
  });

  return router;
}

function latestUserMessage(
  messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>,
) {
  const message = [...messages].reverse().find((item) => item.role === "user");
  const text = message?.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  return text || undefined;
}

function isTerminalEvent(event: AgentLogEvent) {
  return event.type === "error"
    || (event.type === "status" && /task (completed|interrupted)/i.test(event.content));
}