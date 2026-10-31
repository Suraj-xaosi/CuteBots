"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ProjectFileEntry } from "@workspace/types"
import { projectDirectoryQuery, projectFileQuery } from "./queries"

// Listing a folder and reading a file are reads, so they are queries now,
// not mutations. `open` gates fetching: when the dialog opens, the queries
// start by themselves. That replaces the old handleOpen + effect-style flow.
//
// Only navigation (which folder, which file, the filter text) is local state.
// Loading and error come from the queries.
export function useProjectFiles(projectId: string, open: boolean) {
  const [directory, setDirectory] = useState(".")
  const [filePath, setFilePath] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  const listing = useQuery({ ...projectDirectoryQuery(projectId, directory), enabled: open })
  const preview = useQuery({ ...projectFileQuery(projectId, filePath), enabled: open })

  const needle = filter.toLowerCase()
  const entries = listing.data?.entries ?? []
  const filtered = entries.filter((entry:any) => entry.name.toLowerCase().includes(needle))

  const openDirectory = (path: string) => {
    setDirectory(path)
    setFilePath(null)
    setFilter("")
  }

  const openEntry = (entry: ProjectFileEntry) => {
    if (entry.type === "directory") openDirectory(entry.path)
    else setFilePath(entry.path)
  }

  const parent = directory === "." ? null : directory.split("/").slice(0, -1).join("/") || "."

  return {
    directory,
    parent,
    filter,
    setFilter,
    filtered,
    selectedPath: filePath,
    preview: preview.data ?? null,
    busy: listing.isFetching || preview.isFetching,
    error: (listing.error ?? preview.error)?.message ?? null,
    openDirectory,
    openEntry,
  }
}