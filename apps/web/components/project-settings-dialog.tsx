"use client"

import { useState, type FormEvent } from "react"

import { Button } from "@workspace/ui/components/button"
import { DialogFooter } from "@workspace/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import type { ProjectSummary } from "@/lib/agent-api"
import { DashboardDialogFrame } from "@/components/dashboard-dialog-frame"

interface ProjectSettingsDialogProps {
  project: ProjectSummary
  onClose: () => void
  onSaveContext: (projectId: string, context: string, onSuccess: () => void) => void
  contextPending: boolean
  contextError: string | null
  onSaveGithubToken: (projectId: string, token: string, onSuccess: () => void) => void
  githubTokenPending: boolean
  githubTokenError: string | null
}

export function ProjectSettingsDialog({
  project,
  onClose,
  onSaveContext,
  contextPending,
  contextError,
  onSaveGithubToken,
  githubTokenPending,
  githubTokenError,
}: ProjectSettingsDialogProps) {
  const [context, setContext] = useState(() => project.context)
  const [githubToken, setGithubToken] = useState("")

  function saveContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (contextPending || context === project.context) return
    onSaveContext(project.id, context, () => {})
  }

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!githubToken.trim() || githubTokenPending) return
    onSaveGithubToken(project.id, githubToken.trim(), () => setGithubToken(""))
  }

  return (
    <DashboardDialogFrame
      title={`${project.name} settings`}
      onClose={onClose}
      className="w-full max-w-lg"
    >
      <div className="mt-4 space-y-6">
        <form onSubmit={saveContext} className="space-y-3">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-context" className="text-xs">Project context</FieldLabel>
              <p className="text-[11px] text-zinc-500">
                Persistent notes included with future tasks. Conversation history is stored separately.
              </p>
              <Textarea
                id="project-context"
                maxLength={20_000}
                value={context}
                onChange={(event) => setContext(event.target.value)}
                placeholder="Project conventions, architecture notes, or decisions to remember..."
                rows={6}
                className="resize-y rounded-none border-zinc-300 p-2 text-xs shadow-none focus-visible:border-zinc-600 focus-visible:ring-0"
              />
            </Field>
          </FieldGroup>
          {contextError && <p role="alert" className="text-xs text-rose-700">{contextError}</p>}
          <DialogFooter className="flex justify-end border-0 bg-transparent p-0">
            <Button type="submit" size="sm" disabled={contextPending || context === project.context}>
              {contextPending ? "Saving..." : "Save context"}
            </Button>
          </DialogFooter>
        </form>

        <form onSubmit={saveToken} className="space-y-3 border-t border-zinc-200 pt-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-github-token" className="text-xs">GitHub push access</FieldLabel>
              <p className="text-[11px] text-zinc-500">
                {project.github_token_configured ? "A token is stored; entering a new one replaces it." : "No token is stored."} Use a repository-scoped token with Contents read/write permission. The stored token is never shown.
              </p>
              <Input
                id="project-github-token"
                type="password"
                autoComplete="new-password"
                value={githubToken}
                onChange={(event) => setGithubToken(event.target.value)}
                placeholder="Enter a token to set or replace it"
                className="h-9 rounded-none border-zinc-300 px-2 text-xs shadow-none focus-visible:border-zinc-600 focus-visible:ring-0"
              />
            </Field>
          </FieldGroup>
          {githubTokenError && <p role="alert" className="text-xs text-rose-700">{githubTokenError}</p>}
          <DialogFooter className="flex justify-end border-0 bg-transparent p-0">
            <Button type="submit" size="sm" disabled={githubTokenPending || !githubToken.trim()}>
              {githubTokenPending ? "Saving..." : "Save GitHub token"}
            </Button>
          </DialogFooter>
        </form>
      </div>
    </DashboardDialogFrame>
  )
}
