import "@workspace/ui/globals.css"

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
      <body>{children}</body>
    </html>
  )
}
