import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

// UI state only. Nothing in here ever comes from the server.
// Server data (projects, conversations, runs...) lives in the TanStack cache.
export interface WorkspaceUiState {
  selectedProjectId: string | null
  activeConversationId: string | null
  filesOpen: boolean
}

const initialState: WorkspaceUiState = {
  selectedProjectId: null,
  activeConversationId: null,
  filesOpen: false,
}

const workspaceSlice = createSlice({
  name: "workspace",
  initialState,
  reducers: {
    // Changing project also clears the conversation, in exactly one place.
    projectSelected(state, action: PayloadAction<string>) {
      if (state.selectedProjectId === action.payload) return
      state.selectedProjectId = action.payload
      state.activeConversationId = null
    },
    conversationSelected(state, action: PayloadAction<string | null>) {
      state.activeConversationId = action.payload
    },
    filesOpenChanged(state, action: PayloadAction<boolean>) {
      state.filesOpen = action.payload
    },
  },
  selectors: {
    selectSelectedProjectId: (state) => state.selectedProjectId,
    selectActiveConversationId: (state) => state.activeConversationId,
    selectFilesOpen: (state) => state.filesOpen,
  },
})

export const workspaceActions = workspaceSlice.actions
export const { selectSelectedProjectId, selectActiveConversationId, selectFilesOpen } =
  workspaceSlice.selectors
export default workspaceSlice.reducer