"use client"

import { memo } from "react"

import { ProjectCreationDialog } from "@/components/project-creation-dialog"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { SettingsDialog } from "@/components/settings-dialog"
import { useDashboardDialogs } from "@/contexts/dashboard-context"

export const DashboardDialogs = memo(function DashboardDialogs() {
  const {
    projectSettings,
    onCloseProjectSettings,
    onSaveProjectContext,
    contextSavePending,
    contextSaveError,
    onSaveGithubToken,
    githubTokenSavePending,
    githubTokenSaveError,
    showProjectForm,
    onCloseProjectForm,
    onCreateProject,
    projectPending,
    projectError,
    showSettings,
    onCloseSettings,
    settings,
    settingsError,
    settingsLoading,
    onRetrySettings,
    onSaveSettings,
    settingsPending,
    settingsSaveError,
  } = useDashboardDialogs()

  return (
    <>
      {projectSettings && (
        <ProjectSettingsDialog
          key={projectSettings.id}
          project={projectSettings}
          onClose={onCloseProjectSettings}
          onSaveContext={onSaveProjectContext}
          contextPending={contextSavePending}
          contextError={contextSaveError}
          onSaveGithubToken={onSaveGithubToken}
          githubTokenPending={githubTokenSavePending}
          githubTokenError={githubTokenSaveError}
        />
      )}
      {showProjectForm && (
        <ProjectCreationDialog
          onClose={onCloseProjectForm}
          onSubmit={onCreateProject}
          isPending={projectPending}
          submissionError={projectError}
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
          saveError={settingsSaveError}
        />
      )}
    </>
  )
})
