import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"
import { Skeleton } from "@workspace/ui/components/skeleton"

export function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="mx-auto flex h-screen max-w-[1800px] gap-4">
        <aside className="w-[290px] rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <Skeleton className="mb-4 h-16 w-full rounded-xl" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </aside>

        <main className="flex-1 space-y-4">
          <Card className="shadow-sm">
            <CardHeader className="p-4">
              <Skeleton className="h-5 w-40 rounded" />
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <Skeleton className="h-8 w-56 rounded" />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 w-full rounded-xl" />
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1.4fr_0.8fr]">
            <Card className="shadow-sm">
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-8 w-32 rounded" />
                <Skeleton className="h-48 w-full rounded-xl" />
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-8 w-32 rounded" />
                <Skeleton className="h-64 w-full rounded-xl" />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  )
}
