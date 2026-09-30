import express, { type Router } from "express";
import type { SettingsService } from "../services/settings-service.js";

export function createSettingsRouter(settings: SettingsService): Router {
  const router = express.Router();

  router.get("/", async (_request, response) => {
    const result = await settings.getPublicSettings();
    if (!result.ok) {
      response.status(500).json({ error: result.error, code: result.code });
      return;
    }
    response.json(result.data);
  });

  router.put("/", async (request, response) => {
    const result = await settings.update(request.body?.values);
    if (!result.ok) {
      response.status(400).json({ error: result.error, code: result.code });
      return;
    }
    response.json(result.data);
  });

  return router;
}