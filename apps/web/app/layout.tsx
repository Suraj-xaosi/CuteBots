import "@workspace/ui/globals.css"
import { QueryProvider } from "@/components/query-provider"

export const metadata = {
  title: "CuteBots",
  description: "Local coding-agent workspace",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  )
}
