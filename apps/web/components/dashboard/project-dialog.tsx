"use client"

import { useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  PROVIDER_NAMES,
  isProviderName,
  type ProviderName,
} from "@workspace/types"
import { createProject } from "@/lib/actions/projects"
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

export function ProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (projectId: string, setupError: string | null) => void
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
  const create = useMutation({
    mutationFn: createProject,
    gcTime: 0,
    onSuccess: (result) => {
      if (!result.ok) return
      onCreated(result.data.id, result.data.setupError ?? null)
      onOpenChange(false)
    },
  })

  const submit = () => {
    create.mutate({
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
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            <FieldLabel htmlFor="project-token">Repository token (private repositories)</FieldLabel>
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
                {PROVIDER_NAMES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name.charAt(0).toUpperCase() + name.slice(1)}
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
            <Input id="project-provider-url" ref={providerUrl} placeholder="http://localhost:11434/v1" />
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
        {create.data && !create.data.ok ? (
          <DialogDescription className="text-destructive">
            {create.data.error}
          </DialogDescription>
        ) : null}
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? "Creating project and sandbox…" : "Create project"}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
