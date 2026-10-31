import { QueryClient, environmentManager } from "@tanstack/react-query"

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Above 0 so data prefetched on the server is not refetched the
        // instant the client hydrates.
        staleTime: 30_000,
        retry: 1,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

// Server: a fresh client every call (never share a cache between requests).
// Browser: one client for the whole session.
export function getQueryClient() {
  if (environmentManager.isServer()) return makeQueryClient()
  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}