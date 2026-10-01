export const activeTaskStatuses = new Set(["PENDING", "RUNNING"])

export const dashboardRefreshIntervals = {
  activeTasks: 3_000,
  activeTaskFiles: 5_000,
  activeTaskUsage: 5_000,
  openSettings: 3_000,
} as const

export function requireDashboardValue<T>(
  value: T | null | undefined,
  description: string,
): T {
  if (value === null || value === undefined) {
    throw new Error(`${description} is required.`)
  }
  return value
}
