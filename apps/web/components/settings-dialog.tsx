"use client"

import { useState, type FormEvent } from "react"

import { Button } from "@workspace/ui/components/button"
import { DialogFooter } from "@workspace/ui/components/dialog"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { DashboardDialogFrame } from "@/components/dashboard-dialog-frame"
import type { PublicSettings } from "@/lib/agent-api"

interface SettingsDialogProps {
  onClose: () => void
  settings: PublicSettings | undefined
  error: string | null
  isLoading: boolean
  onRetry: () => void
  onSubmit: (values: Record<string, string>, onSuccess: () => void) => void
  isPending: boolean
}

export function SettingsDialog({
  onClose,
  settings,
  error,
  isLoading,
  onRetry,
  onSubmit,
  isPending,
}: SettingsDialogProps) {
  if (isLoading) {
    return (
      <DashboardDialogFrame title="Settings" onClose={onClose} className="w-full max-w-md">
        <p className="mt-4 text-sm text-zinc-600">Loading settings...</p>
      </DashboardDialogFrame>
    )
  }

  if (error || !settings) {
    return (
      <DashboardDialogFrame title="Settings" onClose={onClose} className="w-full max-w-md">
        <p role="alert" className="mt-4 text-sm text-rose-700">
          {error ?? "Settings are unavailable."}
        </p>
        <Button className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      </DashboardDialogFrame>
    )
  }

  return (
    <LoadedSettingsDialog
      key={`${settings.values.LLM_PROVIDER ?? ""}:${settings.values.LLM_MODEL ?? ""}`}
      onClose={onClose}
      settings={settings}
      onSubmit={onSubmit}
      isPending={isPending}
    />
  )
}

function LoadedSettingsDialog({
  onClose,
  settings,
  onSubmit,
  isPending,
}: {
  onClose: () => void
  settings: PublicSettings
  onSubmit: (values: Record<string, string>, onSuccess: () => void) => void
  isPending: boolean
}) {
  const [provider, setProvider] = useState(settings.values.LLM_PROVIDER ?? "openai")
  const [model, setModel] = useState(settings.values.LLM_MODEL ?? "gpt-4.1-mini")
  const [apiKey, setApiKey] = useState("")
  const [telegramToken, setTelegramToken] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(
      {
        LLM_PROVIDER: provider,
        LLM_MODEL: model,
        ...(apiKey.trim() ? { LLM_API_KEY: apiKey.trim() } : {}),
        ...(telegramToken.trim() ? { TELEGRAM_BOT_TOKEN: telegramToken.trim() } : {}),
      },
      clearSecretFields,
    )
  }

  function clearSecretFields() {
    setApiKey("")
    setTelegramToken("")
  }

  return (
    <DashboardDialogFrame title="Settings" onClose={onClose} className="w-full max-w-md">
      <form className="mt-4" onSubmit={submit}>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="llm-provider" className="text-xs">
              Provider
            </FieldLabel>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="llm-provider" className="mt-1 h-10 w-full rounded-none border-zinc-300">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="groq">Groq</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="llm-model" className="text-xs">
              Model
            </FieldLabel>
            <Input
              id="llm-model"
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
            />
          </Field>
          {provider !== "ollama" && (
            <Field>
              <FieldLabel htmlFor="llm-api-key" className="text-xs">
                API key{" "}
                <span className="font-normal text-zinc-500">
                  {settings.configuredSecrets.LLM_API_KEY
                    ? "(configured; leave blank to keep)"
                    : "(not configured)"}
                </span>
              </FieldLabel>
              <Input
                id="llm-api-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
              />
            </Field>
          )}
          <FieldSet className="border-t border-zinc-200 pt-3">
            <FieldLegend variant="label">Telegram</FieldLegend>
            <p className="mt-1 text-xs text-zinc-600">
              Create a bot with{" "}
              <a className="underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                @BotFather
              </a>
              , paste its token, save, then send /start to your bot in Telegram. It will send task status, results, and
              agent questions; reply to an agent question in Telegram to continue.
            </p>
            <Field className="mt-3">
              <FieldLabel htmlFor="telegram-token" className="text-xs">
                Bot token{" "}
                <span className="font-normal text-zinc-500">
                  {settings.configuredSecrets.TELEGRAM_BOT_TOKEN
                    ? settings.configuredSecrets.TELEGRAM_CHAT_ID
                      ? "(connected)"
                      : "(saved; send /start in Telegram to pair)"
                    : "(not configured)"}
                </span>
              </FieldLabel>
              <Input
                id="telegram-token"
                type="password"
                autoComplete="new-password"
                value={telegramToken}
                onChange={(event) => setTelegramToken(event.target.value)}
                className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
              />
            </Field>
            {settings.configuredSecrets.TELEGRAM_BOT_TOKEN && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={isPending}
                onClick={() => onSubmit({ TELEGRAM_BOT_TOKEN: "" }, clearSecretFields)}
              >
                Disable Telegram
              </Button>
            )}
          </FieldSet>
          <DialogFooter className="flex justify-end gap-2 border-0 bg-transparent p-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : "Save settings"}
            </Button>
          </DialogFooter>
        </FieldGroup>
      </form>
    </DashboardDialogFrame>
  )
}
