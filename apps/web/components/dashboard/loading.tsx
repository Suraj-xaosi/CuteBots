import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"
import { Skeleton } from "@workspace/ui/components/skeleton"

export function DashboardLoading() {
  return (
    <Card className="h-dvh rounded-none border-0">
      <CardHeader className="flex-row items-center justify-between border-b">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-64" />
      </CardHeader>
      <CardContent className="grid h-[calc(100dvh-4rem)] grid-cols-[minmax(12rem,20%)_1fr_minmax(15rem,24%)] gap-4 p-4">
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
      </CardContent>
    </Card>
  )
}
