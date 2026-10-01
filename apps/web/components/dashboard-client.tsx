"use client"

import dynamic from "next/dynamic"

import { DashboardSkeleton } from "@/components/dashboard-skeleton"

const DashboardShell = dynamic(
  () => import("@/components/dashboard-workspace").then((module) => module.DashboardWorkspace),
  {
    loading: () => <DashboardSkeleton />,
    ssr: false,
  },
)

export function DashboardClient() {
  return <DashboardShell />
}
