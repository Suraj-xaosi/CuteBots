import type { Dispatch } from "react"
import type { WorkspaceAction, WorkspaceUiState } from "./workspace-slice"

export {
  initialWorkspaceState,
  selectActiveConversationId,
  selectFilesOpen,
  selectSelectedProjectId,
  workspaceActions,
  workspaceReducer,
} from "./workspace-slice"

export type AppDispatch = Dispatch<WorkspaceAction>
export type RootState = WorkspaceUiState
export type AppStore = {
  dispatch: AppDispatch
  getState: () => RootState
}
