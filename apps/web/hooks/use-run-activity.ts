"use client"

import { useQuery } from "@tanstack/react-query"
import type { ActivityItem } from "@workspace/types"
import { runActivityQuery } from "./queries"

// Stable reference so components do not see a "new" array every render.
const EMPTY: ActivityItem[] = []

// Read-only. The stream (lib/query/run-stream.ts) is what writes into this.
export function useRunActivity(runId: string | null) {
  const { data } = useQuery(runActivityQuery(runId))
  return data ?? EMPTY
}