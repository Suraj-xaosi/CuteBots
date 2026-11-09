"use client"

import { ChevronUp, FileCode2, Folder } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription } from "@workspace/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import type { ProjectFileEntry } from "@workspace/types"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable"
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
      <DialogContent
        className="h-[min(860px,94dvh)] w-[min(1200px,96vw)] max-w-[min(1200px,96vw)] rounded-[20px] border border-border/80 bg-background p-3 shadow-[0_24px_90px_rgba(0,0,0,0.12)] sm:max-w-[min(1200px,96vw)]"
        onPointerDownOutside={(event) => {
          const target = event.target
          if (target instanceof HTMLElement && target.closest("[data-slot='resizable-handle']")) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="flex-row items-center justify-between gap-0 px-2 pb-1 pt-0">
          <DialogTitle className="m-0 text-[1.5rem] leading-none font-semibold tracking-[-0.04em] text-foreground">
            Project files
          </DialogTitle>
        </DialogHeader>
        <Card className="grid h-[calc(100%-2.5rem)] min-h-0 overflow-hidden rounded-[18px] border border-border/80 bg-muted/20 py-0 shadow-inner shadow-black/5">
          <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
            <ResizablePanel defaultSize={38} minSize={20} className="min-w-0">
              <CardContent className="flex h-full min-h-0 flex-col bg-background/65 p-3">
                <Field className="p-1">
                  <FieldLabel htmlFor="file-filter" className="text-sm font-medium text-foreground/80">
                    Workspace · {directory}
                  </FieldLabel>
                  <Input
                    id="file-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter files"
                    className="h-11 rounded-xl border border-border bg-background text-sm shadow-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                  />
                </Field>
                {parent ? (
                  <Button
                    variant="ghost"
                    className="mt-2 h-9 justify-start rounded-xl px-2 text-sm font-medium text-foreground/85 hover:bg-foreground hover:text-background"
                    onClick={() => openDirectory(parent)}
                  >
                    <ChevronUp />
                    Parent directory
                  </Button>
                ) : null}
                <ScrollArea className="mt-2 min-h-0 flex-1">
                  <CardContent className="grid gap-1.5 p-1">
                    {filtered.map((entry: ProjectFileEntry) => (
                      <Button
                        key={entry.path}
                        variant={selectedPath === entry.path ? "secondary" : "ghost"}
                        className={
                          selectedPath === entry.path
                            ? "justify-start overflow-hidden rounded-xl bg-foreground px-2.5 text-sm font-medium text-background shadow-sm hover:bg-foreground hover:text-background"
                            : "justify-start overflow-hidden rounded-xl px-2.5 text-sm font-medium text-foreground/90 hover:bg-foreground hover:text-background"
                        }
                        onClick={() => openEntry(entry)}
                      >
                        {entry.type === "directory" ? <Folder /> : <FileCode2 />}
                        {entry.name}
                      </Button>
                    ))}
                    {!filtered.length && !busy ? (
                      <CardDescription className="p-3 text-sm text-muted-foreground">
                        {error || "No files in this folder."}
                      </CardDescription>
                    ) : null}
                  </CardContent>
                </ScrollArea>
              </CardContent>
            </ResizablePanel>
            <ResizableHandle withHandle className="w-3 cursor-col-resize bg-transparent transition-colors hover:bg-muted/30" />
            <ResizablePanel className="min-w-0">
              <ScrollArea className="h-full min-h-0 bg-background/30">
                {preview ? (
                  <CardContent className="grid gap-3 p-4">
                    <CardDescription className="px-1 text-sm font-medium text-muted-foreground">
                      {preview.path} · {preview.size} bytes
                    </CardDescription>
                    <CardContent className="overflow-x-auto rounded-xl border border-border/80 bg-muted/80 p-4 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground/90 shadow-inner shadow-black/5">
                      {preview.content}
                    </CardContent>
                  </CardContent>
                ) : (
                  <CardContent className="grid min-h-48 place-items-center p-6">
                    <CardDescription className="text-sm text-muted-foreground">
                      {busy ? "Loading workspace…" : error || "Choose a file to preview it."}
                    </CardDescription>
                  </CardContent>
                )}
              </ScrollArea>
            </ResizablePanel>
          </ResizablePanelGroup>
        </Card>
      </DialogContent>
    </Dialog>
  )
}