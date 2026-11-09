"use client"

import { useState, type ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { getQueryClient } from "@/hooks/get-query-client"
import { WorkspaceProvider } from "@/store/workspace-context"

// Mount once in app/layout.tsx (a server component) around {children}.
// useState with a lazy initializer creates each thing exactly once per mount,
// no useRef flag and no effect.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient)

  return (
    <WorkspaceProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WorkspaceProvider>
  )
}