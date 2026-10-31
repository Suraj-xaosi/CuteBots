"use client"

import { useRef, useState } from "react"
import { PROVIDER_NAMES, isProviderName, type ProviderName } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  useProjectCredentials,
  useSaveProjectCredentials,
} from "../../hooks/use-project-credentials"

type Credentials = NonNullable<ReturnType<typeof useProjectCredentials>["data"]>

// The dialog owns the fetch (it starts when `open` turns true).
// The form is a separate component that only mounts once the data exists,
// so its useState can start from the server values directly. That is what
// replaces "fetch, then copy into state in an effect".
export function SettingsDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const credentials = useProjectCredentials(projectId, open)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Secret fields are encrypted at rest and never displayed again.
          </DialogDescription>
        </DialogHeader>
        {credentials.data ? (
          <SettingsForm key={projectId} projectId={projectId} initial={credentials.data} />
        ) : credentials.isError ? (
          <DialogDescription className="text-destructive">
            {credentials.error?.message}
          </DialogDescription>
        ) : (
          <DialogDescription>Loading settings…</DialogDescription>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SettingsForm({ projectId, initial }: { projectId: string; initial: Credentials }) {
  const [provider, setProvider] = useState<ProviderName>(
    isProviderName(initial.provider) ? initial.provider : "openai"
  )
  const [model, setModel] = useState(initial.model ?? "")
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "")
  const apiKey = useRef<HTMLInputElement>(null)
  const tavilyKey = useRef<HTMLInputElement>(null)
  const repositoryToken = useRef<HTMLInputElement>(null)
  const save = useSaveProjectCredentials(projectId)

  const submit = () => {
    const key = apiKey.current?.value
    const tavily = tavilyKey.current?.value
    const token = repositoryToken.current?.value

    save.mutate(
      {
        provider,
        model,
        baseUrl,
        ...(key ? { apiKey: key } : {}),
        ...(tavily ? { tavilyApiKey: tavily } : {}),
        ...(token ? { repositoryToken: token } : {}),
      },
      {
        // Secrets are write-only: wipe the inputs once they are saved.
        onSuccess: () => {
          for (const input of [apiKey, tavilyKey, repositoryToken]) {
            if (input.current) input.current.value = ""
          }
        },
      }
    )
  }

  return (
    <>
      <Field>
        <FieldLabel>AI provider</FieldLabel>
        <Select
          value={provider}
          onValueChange={(value) => {
            if (isProviderName(value)) setProvider(value)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_NAMES.map((option) => (
              <SelectItem key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-model">Model</FieldLabel>
        <Input id="settings-model" value={model} onChange={(event) => setModel(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-url">Provider URL</FieldLabel>
        <Input
          id="settings-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-key">Replace API key</FieldLabel>
        <Input id="settings-key" ref={apiKey} type="password" />
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-tavily">Replace Tavily key</FieldLabel>
        <Input id="settings-tavily" ref={tavilyKey} type="password" />
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-repo-token">Replace repository token</FieldLabel>
        <Input id="settings-repo-token" ref={repositoryToken} type="password" />
      </Field>
      {save.error ? (
        <DialogDescription className="text-destructive">{save.error.message}</DialogDescription>
      ) : null}
      {save.isSuccess ? <DialogDescription>Settings saved securely.</DialogDescription> : null}
      <Button onClick={submit} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save settings"}
      </Button>
    </>
  )
}