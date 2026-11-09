import type { Dispatch } from "react"
import { useWorkspaceContext } from "./workspace-context"
import type { WorkspaceAction, WorkspaceUiState } from "./workspace-slice"

export type AppDispatch = Dispatch<WorkspaceAction>
export type RootState = WorkspaceUiState
export type AppStore = {
  dispatch: AppDispatch
  getState: () => RootState
}

export function useAppSelector<T>(selector: (state: RootState) => T) {
  const { state } = useWorkspaceContext()
  return selector(state)
}

export function useAppDispatch(): AppDispatch {
  const { dispatch } = useWorkspaceContext()
  return dispatch
}

export function useAppStore(): AppStore {
  const { state, dispatch } = useWorkspaceContext()

  return {
    dispatch,
    getState: () => state,
  }
}