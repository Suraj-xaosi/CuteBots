import "@workspace/ui/globals.css"
import { Providers } from "@/components/query-provider"


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
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  )
}
