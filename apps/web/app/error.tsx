"use client"

import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <Card className="m-auto mt-16 max-w-lg">
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
        <CardDescription>
          The workspace could not load. Try again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={reset}>Retry</Button>
      </CardContent>
    </Card>
  )
}
