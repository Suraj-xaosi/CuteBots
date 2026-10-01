"use client"

import { useState, type FormEvent } from "react"

import { Button } from "@workspace/ui/components/button"
import { DialogFooter } from "@workspace/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { DashboardDialogFrame } from "@/components/dashboard-dialog-frame"
import type { CreateProjectInput } from "@/lib/agent-api"

interface ProjectCreationDialogProps {
  onClose: () => void
  onSubmit: (input: CreateProjectInput) => void
  isPending: boolean
}

export function ProjectCreationDialog({
  onClose,
  onSubmit,
  isPending,
}: ProjectCreationDialogProps) {
  const [name, setName] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [cloneCredential, setCloneCredential] = useState("")
  const [githubToken, setGithubToken] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit({
      name: name.trim(),
      repo_url: repoUrl.trim(),
      ...(cloneCredential ? { clone_credential: cloneCredential } : {}),
      ...(githubToken ? { github_token: githubToken } : {}),
    })
  }

  return (
    <DashboardDialogFrame
      title="New project"
      onClose={onClose}
      className="w-full max-w-lg"
    >
      <form onSubmit={submit} className="mt-4">
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="project-name" className="text-xs">
              Project name
            </FieldLabel>
            <Input
              id="project-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-repo-url" className="text-xs">
              GitHub repository URL
            </FieldLabel>
            <Input
              id="project-repo-url"
              required
              type="url"
              placeholder="https://github.com/owner/repository"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-clone-credential" className="text-xs">
              Read-only clone credential{" "}
              <span className="font-normal text-zinc-500">(private repositories)</span>
            </FieldLabel>
            <Input
              id="project-clone-credential"
              type="password"
              autoComplete="off"
              value={cloneCredential}
              onChange={(event) => setCloneCredential(event.target.value)}
              className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-github-token" className="text-xs">
              GitHub write token{" "}
              <span className="font-normal text-zinc-500">(push and pull requests)</span>
            </FieldLabel>
            <Input
              id="project-github-token"
              type="password"
              autoComplete="off"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm"
            />
          </Field>
          <DialogFooter className="flex justify-end gap-2 border-0 bg-transparent p-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating..." : "Create project"}
            </Button>
          </DialogFooter>
        </FieldGroup>
      </form>
    </DashboardDialogFrame>
  )
}
