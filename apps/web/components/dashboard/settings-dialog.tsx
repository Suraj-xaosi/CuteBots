"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  PROVIDER_NAMES,
  isProviderName,
  type ProviderName,
} from "@workspace/types"
import {
  getProjectCredentials,
  saveProjectCredentials,
} from "@/lib/actions/project-credentials"
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

export function SettingsDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [provider, setProvider] = useState<ProviderName>("openai")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [tavilyApiKey, setTavilyApiKey] = useState("")
  const [repositoryToken, setRepositoryToken] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState("")
  const save = useMutation({
    mutationFn: () =>
      saveProjectCredentials(projectId, {
        provider,
        model,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(tavilyApiKey ? { tavilyApiKey } : {}),
        ...(repositoryToken ? { repositoryToken } : {}),
      }),
    gcTime: 0,
    onSuccess: (result) => {
      setMessage(result.ok ? "Settings saved securely." : result.error)
      if (result.ok) {
        setApiKey("")
        setTavilyApiKey("")
        setRepositoryToken("")
      }
    },
  })

  const openSettings = async (next: boolean) => {
    onOpenChange(next)
    if (!next || loaded) return

    const result = await getProjectCredentials(projectId)
    if (!result.ok) {
      setMessage(result.error)
      return
    }

    const credentials = result.data
    setProvider(isProviderName(credentials.provider) ? credentials.provider : "openai")
    setModel(credentials.model ?? "")
    setBaseUrl(credentials.baseUrl ?? "")
    setLoaded(true)
  }

  return (
    <Dialog open={open} onOpenChange={openSettings}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Secret fields are encrypted at rest and never displayed again.
          </DialogDescription>
        </DialogHeader>
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
              {PROVIDER_NAMES.map((name) => (
                <SelectItem key={name} value={name}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
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
          <Input id="settings-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-key">Replace API key</FieldLabel>
          <Input id="settings-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-tavily">Replace Tavily key</FieldLabel>
          <Input id="settings-tavily" type="password" value={tavilyApiKey} onChange={(event) => setTavilyApiKey(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-repo-token">Replace repository token</FieldLabel>
          <Input id="settings-repo-token" type="password" value={repositoryToken} onChange={(event) => setRepositoryToken(event.target.value)} />
        </Field>
        {message ? <DialogDescription>{message}</DialogDescription> : null}
        <Button onClick={() => save.mutate()} disabled={!loaded || save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
