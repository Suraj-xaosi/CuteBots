"use client"

import { ChevronUp, FileCode2, Folder } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription } from "@workspace/ui/components/card"
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
import { useProjectFiles } from "@/hooks/use-project-files"

// `open` is passed straight to the hook, which uses it to gate fetching.
// There is no "load on open" handler: opening the dialog is what starts the
// queries, and closing it stops them.
export function FileDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    directory,
    parent,
    filter,
    setFilter,
    filtered,
    selectedPath,
    preview,
    busy,
    error,
    openDirectory,
    openEntry,
  } = useProjectFiles(projectId, open)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(760px,90dvh)] max-w-5xl grid-rows-[auto_1fr]">
        <DialogHeader>
          <DialogTitle>Project files</DialogTitle>
          <DialogDescription>Files are read from the isolated project workspace.</DialogDescription>
        </DialogHeader>
        <Card className="grid min-h-0 grid-cols-[minmax(9rem,34%)_1fr] overflow-hidden py-0">
          <CardContent className="flex min-h-0 flex-col border-r p-2">
            <Field className="p-1">
              <FieldLabel htmlFor="file-filter">Workspace · {directory}</FieldLabel>
              <Input
                id="file-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files"
              />
            </Field>
            {parent ? (
              <Button variant="ghost" className="justify-start" onClick={() => openDirectory(parent)}>
                <ChevronUp />
                Parent directory
              </Button>
            ) : null}
            <ScrollArea className="min-h-0 flex-1">
              <CardContent className="grid gap-1 p-1">
                {filtered.map((entry:any) => (
                  <Button
                    key={entry.path}
                    variant={selectedPath === entry.path ? "secondary" : "ghost"}
                    className="justify-start overflow-hidden"
                    onClick={() => openEntry(entry)}
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
                <CardDescription>
                  {preview.path} · {preview.size} bytes
                </CardDescription>
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