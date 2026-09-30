import dotenv from "dotenv";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { prisma, PrismaAgentPersistence } from "@workspace/db";
import { ContainerManager, HumanReplyInbox, SSEBroker } from "@workspace/core";
import { createAgentApp } from "./app.js";
import { createTaskChannelRouter } from "./task-channel-router.js";
import { createProjectRouter } from "./routes/project-routes.js";
import { createTaskRouter } from "./routes/task-routes.js";
import { createFileRouter } from "./routes/file-routes.js";
import { createSandboxRouter } from "./routes/sandbox-routes.js";
import { createSettingsRouter } from "./routes/settings-routes.js";
import { AgentRuntimeFactory } from "./services/agent-runtime.js";
import { ProjectService } from "./services/project-service.js";
import { SettingsService } from "./services/settings-service.js";
import { TaskService } from "./services/task-service.js";

dotenv.config({ path: resolve(import.meta.dirname, "../../..", ".env") });

export async function startAgentServer(): Promise<void> {
  await prisma.$connect();
  const persistence = new PrismaAgentPersistence(prisma);
  const replies = new HumanReplyInbox();
  const sseBroker = new SSEBroker(persistence);
  const containers = ContainerManager.getInstance();
  const settings = new SettingsService(prisma);
  const projects = new ProjectService(prisma, containers);
  await projects.recoverOnStartup();
  const runtime = new AgentRuntimeFactory({ prisma, persistence, settings, containers, sseBroker, replies });
  const tasks = new TaskService(prisma, runtime.loops, replies);

  const taskChannelRouter = createTaskChannelRouter(sseBroker, replies, {
    exists: async (taskId) => Boolean(await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } })),
    isRunning: async (taskId) => {
      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      return task?.status === "RUNNING";
    },
  });

  const app = createAgentApp({
    projects: createProjectRouter(projects, tasks),
    tasks: createTaskRouter(tasks),
    taskChannels: taskChannelRouter,
    files: createFileRouter(projects),
    sandboxes: createSandboxRouter(projects, tasks),
    settings: createSettingsRouter(settings),
  });
  const port = parsePort(process.env.PORT);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolveServer, reject) => {
    const listener = app.listen(port, "0.0.0.0", () => resolveServer(listener));
    listener.once("error", reject);
  });

  const shutdown = () => {
    server.close(() => {
      void prisma.$disconnect();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Agent server listening on port ${port}`);
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 3001 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) {
  void startAgentServer().catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Agent server failed to start");
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}