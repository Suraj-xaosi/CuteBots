import { configureStore } from "@reduxjs/toolkit"
import workspaceReducer from "./workspace-slice"

export const makeStore = () =>
  configureStore({
    reducer: {
      workspace: workspaceReducer,
    },
  })

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore["getState"]>
export type AppDispatch = AppStore["dispatch"]
