"use client"

import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react"
import {
  initialWorkspaceState,
  workspaceReducer,
  type WorkspaceAction,
  type WorkspaceUiState,
} from "./workspace-slice"

export interface WorkspaceContextValue {
  state: WorkspaceUiState
  dispatch: Dispatch<WorkspaceAction>
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({
  children,
  initialState = initialWorkspaceState,
}: {
  children: ReactNode
  initialState?: WorkspaceUiState
}) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState)

  return <WorkspaceContext.Provider value={{ state, dispatch }}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)

  if (!context) {
    throw new Error("WorkspaceProvider is required to use workspace state")
  }

  return context
}
