"use client"

import dynamic from "next/dynamic"

import { DashboardSkeleton } from "@/components/dashboard-skeleton"

const DashboardShell = dynamic(
  () => import("@/components/dashboard-shell").then((module) => module.DashboardShell),
  {
    loading: () => <DashboardSkeleton />,
    ssr: false,
  },
)

export function DashboardClient() {
  return <DashboardShell />
}
