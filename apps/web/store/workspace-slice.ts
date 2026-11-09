// UI state only. Nothing in here ever comes from the server.
// Server data (projects, conversations, runs...) lives in the TanStack cache.
export interface WorkspaceUiState {
  selectedProjectId: string | null
  activeConversationId: string | null
  filesOpen: boolean
}

export const initialWorkspaceState: WorkspaceUiState = {
  selectedProjectId: null,
  activeConversationId: null,
  filesOpen: false,
}

export type WorkspaceAction =
  | { type: "projectSelected"; payload: string }
  | { type: "projectCleared" }
  | { type: "conversationSelected"; payload: string | null }
  | { type: "filesOpenChanged"; payload: boolean }

export function workspaceReducer(
  state: WorkspaceUiState = initialWorkspaceState,
  action: WorkspaceAction,
): WorkspaceUiState {
  switch (action.type) {
    case "projectSelected": {
      if (state.selectedProjectId === action.payload) {
        return state
      }

      return {
        ...state,
        selectedProjectId: action.payload,
        activeConversationId: null,
      }
    }

    case "projectCleared": {
      return {
        ...state,
        selectedProjectId: null,
        activeConversationId: null,
      }
    }

    case "conversationSelected": {
      return {
        ...state,
        activeConversationId: action.payload,
      }
    }

    case "filesOpenChanged": {
      return {
        ...state,
        filesOpen: action.payload,
      }
    }

    default:
      return state
  }
}

export const workspaceActions = {
  projectSelected: (payload: string): WorkspaceAction => ({ type: "projectSelected", payload }),
  projectCleared: (): WorkspaceAction => ({ type: "projectCleared" }),
  conversationSelected: (payload: string | null): WorkspaceAction => ({
    type: "conversationSelected",
    payload,
  }),
  filesOpenChanged: (payload: boolean): WorkspaceAction => ({ type: "filesOpenChanged", payload }),
} as const

export const selectSelectedProjectId = (state: WorkspaceUiState) => state.selectedProjectId
export const selectActiveConversationId = (state: WorkspaceUiState) => state.activeConversationId
export const selectFilesOpen = (state: WorkspaceUiState) => state.filesOpen

export default workspaceReducer