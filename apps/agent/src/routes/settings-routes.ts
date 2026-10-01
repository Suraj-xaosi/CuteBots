import express, { type Router } from "express";
import type { Result } from "@workspace/types";
import type { SettingsService } from "../services/settings-service.js";

export function createSettingsRouter(
  settings: SettingsService,
  onTelegramTokenChanged?: (token: string) => Promise<Result<void>>,
): Router {
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
    const values = request.body?.values as Record<string, string> | undefined;
    if (values && Object.hasOwn(values, "TELEGRAM_BOT_TOKEN") && onTelegramTokenChanged) {
      const configured = await settings.getResolved("TELEGRAM_BOT_TOKEN");
      if (!configured.ok) {
        response.status(500).json({ error: configured.error, code: configured.code });
        return;
      }
      const updated = await onTelegramTokenChanged(configured.data ?? "");
      if (!updated.ok) {
        response.status(400).json({ error: `Telegram could not start: ${updated.error}`, code: updated.code });
        return;
      }
    }
    response.json(result.data);
  });

  return router;
}