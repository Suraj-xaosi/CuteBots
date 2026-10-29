"use client"

import { useMemo, useRef, useState } from "react"
import { Folder, FileCode2, ChevronUp } from "lucide-react"
import { listProjectFiles, readProjectFile } from "@/lib/actions/sandbox"
import type { ProjectFileEntry, ProjectFilePreview } from "@workspace/types"
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
import { Card, CardContent, CardDescription } from "@workspace/ui/components/card"

export function FileDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const search = useRef<HTMLInputElement>(null)
  const [directory, setDirectory] = useState(".")
  const [entries, setEntries] = useState<ProjectFileEntry[]>([])
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState("")

  const filtered = useMemo(
    () => entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())),
    [entries, filter]
  )

  const openDirectory = async (path: string) => {
    setBusy(true)
    setError("")
    setPreview(null)
    const result = await listProjectFiles(projectId, path)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDirectory(path)
    setEntries(result.data.entries)
  }

  const openFile = async (entry: ProjectFileEntry) => {
    if (entry.type === "directory") return openDirectory(entry.path)
    setBusy(true)
    setError("")
    const result = await readProjectFile(projectId, entry.path)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setPreview(result.data)
  }

  const handleOpen = async (next: boolean) => {
    onOpenChange(next)
    if (next) await openDirectory(".")
  }

  const parent = directory === "." ? null : directory.split("/").slice(0, -1).join("/") || "."

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="h-[min(760px,90dvh)] max-w-5xl grid-rows-[auto_1fr]">
        <DialogHeader>
          <DialogTitle>Project files</DialogTitle>
          <DialogDescription>
            Files are read from the isolated project workspace.
          </DialogDescription>
        </DialogHeader>
        <Card className="grid min-h-0 grid-cols-[minmax(9rem,34%)_1fr] overflow-hidden py-0">
          <CardContent className="flex min-h-0 flex-col border-r p-2">
            <Field className="p-1">
              <FieldLabel htmlFor="file-filter">Workspace · {directory}</FieldLabel>
              <Input
                id="file-filter"
                ref={search}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files"
              />
            </Field>
            {parent ? (
              <Button variant="ghost" className="justify-start" onClick={() => void openDirectory(parent)}>
                <ChevronUp />
                Parent directory
              </Button>
            ) : null}
            <ScrollArea className="min-h-0 flex-1">
              <CardContent className="grid gap-1 p-1">
                {filtered.map((entry) => (
                  <Button
                    key={entry.path}
                    variant={preview?.path === entry.path ? "secondary" : "ghost"}
                    className="justify-start overflow-hidden"
                    onClick={() => void openFile(entry)}
                  >
                    {entry.type === "directory" ? <Folder /> : <FileCode2 />}
                    {entry.name}
                  </Button>
                ))}
                {!filtered.length && !busy ? (
                  <CardDescription className="p-3">
                    {error || "No files in this folder."}
                  </CardDescription>
                ) : null}
              </CardContent>
            </ScrollArea>
          </CardContent>
          <ScrollArea className="min-h-0">
            {preview ? (
              <CardContent className="grid gap-2 p-4">
                <CardDescription>{preview.path} · {preview.size} bytes</CardDescription>
                <CardContent className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre">
                  {preview.content}
                </CardContent>
              </CardContent>
            ) : (
              <CardContent className="grid min-h-48 place-items-center p-6">
                <CardDescription>
                  {busy ? "Loading workspace…" : error || "Choose a file to preview it."}
                </CardDescription>
              </CardContent>
            )}
          </ScrollArea>
        </Card>
      </DialogContent>
    </Dialog>
  )
}
