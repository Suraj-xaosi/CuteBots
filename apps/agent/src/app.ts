import express, { type Router } from "express";
import { errorHandler, notFoundHandler } from "./http/api-error.js";

export interface AgentRouters {
  projects?: Router;
  tasks?: Router;
  taskChannels?: Router;
  files?: Router;
  sandboxes?: Router;
  settings?: Router;
}

export function createAgentApp(routers: AgentRouters = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  if (routers.projects) app.use("/api/projects", routers.projects);
  if (routers.files) app.use("/api/projects", routers.files);
  if (routers.sandboxes) app.use("/api/projects", routers.sandboxes);
  if (routers.tasks) app.use("/api/tasks", routers.tasks);
  if (routers.taskChannels) app.use("/api/tasks", routers.taskChannels);
  if (routers.settings) app.use("/api/settings", routers.settings);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}