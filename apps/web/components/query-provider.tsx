"use client"

import { useState, type ReactNode } from "react"
import { Provider as ReduxProvider } from "react-redux"
import { QueryClientProvider } from "@tanstack/react-query"
import { getQueryClient } from "@/hooks/get-query-client"
import { makeStore } from "@/store/store"

// Mount once in app/layout.tsx (a server component) around {children}.
// useState with a lazy initializer creates each thing exactly once per mount,
// no useRef flag and no effect.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient)
  const [store] = useState(makeStore)

  return (
    <ReduxProvider store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ReduxProvider>
  )
}