"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 0, gcTime: 0, retry: false },
          mutations: { gcTime: 0, retry: false },
        },
      })
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
