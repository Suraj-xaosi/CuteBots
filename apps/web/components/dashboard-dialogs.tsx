"use client"

import { memo } from "react"

import { ProjectCreationDialog } from "@/components/project-creation-dialog"
import { SettingsDialog } from "@/components/settings-dialog"
import { useDashboardDialogs } from "@/contexts/dashboard-context"

export const DashboardDialogs = memo(function DashboardDialogs() {
  const {
    showProjectForm,
    onCloseProjectForm,
    onCreateProject,
    projectPending,
    showSettings,
    onCloseSettings,
    settings,
    settingsError,
    settingsLoading,
    onRetrySettings,
    onSaveSettings,
    settingsPending,
  } = useDashboardDialogs()

  return (
    <>
      {showProjectForm && (
        <ProjectCreationDialog
          onClose={onCloseProjectForm}
          onSubmit={onCreateProject}
          isPending={projectPending}
        />
      )}
      {showSettings && (
        <SettingsDialog
          onClose={onCloseSettings}
          settings={settings}
          error={settingsError}
          isLoading={settingsLoading}
          onRetry={onRetrySettings}
          onSubmit={onSaveSettings}
          isPending={settingsPending}
        />
      )}
    </>
  )
})
