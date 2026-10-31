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
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { useCreateProject } from "@/hooks/use-projects"

// Uncontrolled inputs read through refs: nothing re-renders per keystroke and
// the form is empty again every time the dialog content mounts.
// On success the hook already selected the new project; the dialog only has
// to close, unless setup failed, in which case it stays open and says so.
export function ProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const name = useRef<HTMLInputElement>(null)
  const repository = useRef<HTMLInputElement>(null)
  const branch = useRef<HTMLInputElement>(null)
  const repositoryToken = useRef<HTMLInputElement>(null)
  const apiKey = useRef<HTMLInputElement>(null)
  const model = useRef<HTMLInputElement>(null)
  const providerUrl = useRef<HTMLInputElement>(null)
  const tavilyKey = useRef<HTMLInputElement>(null)
  const instructions = useRef<HTMLTextAreaElement>(null)
  const [provider, setProvider] = useState<ProviderName>("openai")
  const create = useCreateProject()

  const handleOpenChange = (next: boolean) => {
    if (!next) create.reset()
    onOpenChange(next)
  }

  const submit = () => {
    create.mutate(
      {
        name: name.current?.value ?? "",
        repositoryUrl: repository.current?.value ?? "",
        branchName: branch.current?.value,
        repositoryToken: repositoryToken.current?.value,
        provider,
        apiKey: apiKey.current?.value,
        model: model.current?.value,
        baseUrl: providerUrl.current?.value,
        tavilyApiKey: tavilyKey.current?.value,
        context: instructions.current?.value,
      },
      {
        onSuccess: (created) => {
          if (!created.setupError) handleOpenChange(false)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            Connect a GitHub repository. CuteBots will provision its sandbox.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65dvh] pr-3">
          <Field className="mb-4">
            <FieldLabel htmlFor="project-name">Project name</FieldLabel>
            <Input id="project-name" ref={name} placeholder="My app" />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-repository">GitHub repository URL</FieldLabel>
            <Input
              id="project-repository"
              ref={repository}
              placeholder="https://github.com/owner/repository"
            />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-branch">Default branch (optional)</FieldLabel>
            <Input id="project-branch" ref={branch} placeholder="main" />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-token">
              Repository token (private repositories)
            </FieldLabel>
            <Input id="project-token" ref={repositoryToken} type="password" />
          </Field>
          <Field className="mb-4">
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
          <Field className="mb-4">
            <FieldLabel htmlFor="project-api-key">Provider API key</FieldLabel>
            <Input id="project-api-key" ref={apiKey} type="password" />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-model">Model (optional)</FieldLabel>
            <Input id="project-model" ref={model} placeholder="Provider default" />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-provider-url">
              Provider URL (required for Ollama)
            </FieldLabel>
            <Input
              id="project-provider-url"
              ref={providerUrl}
              placeholder="http://localhost:11434/v1"
            />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-tavily-key">Tavily key (optional)</FieldLabel>
            <Input id="project-tavily-key" ref={tavilyKey} type="password" />
          </Field>
          <Field className="mb-4">
            <FieldLabel htmlFor="project-context">Project instructions (optional)</FieldLabel>
            <Textarea id="project-context" ref={instructions} rows={4} />
          </Field>
        </ScrollArea>
        {create.error ? (
          <DialogDescription className="text-destructive">{create.error.message}</DialogDescription>
        ) : null}
        {create.data?.setupError ? (
          <DialogDescription className="text-destructive">
            The project was created, but sandbox setup failed: {create.data.setupError}
          </DialogDescription>
        ) : null}
        <Button onClick={submit} disabled={create.isPending || create.isSuccess}>
          {create.isPending ? "Creating project and sandbox…" : "Create project"}
        </Button>
      </DialogContent>
    </Dialog>
  )
}