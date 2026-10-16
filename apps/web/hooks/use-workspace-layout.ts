"use client"

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"

interface WorkspaceLayout {
  filesShare: number
  previewShare: number
  activityShare: number
}

type ResizeDrag =
  | { axis: "horizontal"; start: number; leftColumn: "files" | "preview"; rightColumn: "preview" | "right"; filesShare: number; previewShare: number }
  | { axis: "vertical"; start: number; activityShare: number }

const LAYOUT_STORAGE_KEY = "cutebots.workspace-layout.v1"
const defaultWorkspaceLayout: WorkspaceLayout = {
  filesShare: 20,
  previewShare: 48,
  activityShare: 50,
}

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultWorkspaceLayout)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ResizeDrag | null>(null)
  const layoutRef = useRef(layout)

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
      // Read persisted layout after hydration to avoid server/client markup mismatch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setLayout(parseWorkspaceLayout(JSON.parse(stored)))
    } catch (error) {
      console.error("Unable to load the saved workspace sizes.", error)
    } finally {
      setLayoutLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!layoutLoaded) return
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    } catch (error) {
      console.error("Unable to save the workspace sizes.", error)
    }
  }, [layout, layoutLoaded])

  function beginHorizontalResize(event: ReactPointerEvent<HTMLDivElement>, divider: "first" | "second") {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const leftColumn = divider === "first" ? "files" : "preview"
    const rightColumn = divider === "first" ? "preview" : "right"
    dragRef.current = {
      axis: "horizontal",
      start: event.clientX,
      leftColumn,
      rightColumn,
      filesShare: layoutRef.current.filesShare,
      previewShare: layoutRef.current.previewShare,
    }
  }

  function moveHorizontalResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.axis !== "horizontal") return
    const availableWidth = Math.max(1, (gridRef.current?.scrollWidth ?? 1000) - 12)
    const delta = (event.clientX - drag.start) / availableWidth * 100
    const current = layoutRef.current
    const rightShare = 100 - drag.filesShare - drag.previewShare
    let filesShare = drag.filesShare
    let previewShare = drag.previewShare

    if (drag.leftColumn === "files" && drag.rightColumn === "preview") {
      filesShare = clamp(drag.filesShare + delta, 14, Math.min(38, drag.filesShare + drag.previewShare - 24))
      previewShare = drag.filesShare + drag.previewShare - filesShare
    } else if (drag.leftColumn === "preview" && drag.rightColumn === "right") {
      previewShare = clamp(drag.previewShare + delta, 24, Math.min(64, drag.previewShare + rightShare - 20))
    } else if (drag.leftColumn === "files" && drag.rightColumn === "right") {
      filesShare = clamp(drag.filesShare + delta, 14, Math.min(38, drag.filesShare + rightShare - 24))
    }

    setLayout({ ...current, filesShare, previewShare })
  }

  function beginVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      axis: "vertical",
      start: event.clientY,
      activityShare: layoutRef.current.activityShare,
    }
  }

  function moveVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.axis !== "vertical") return
    const height = Math.max(1, event.currentTarget.parentElement?.getBoundingClientRect().height ?? 1)
    const delta = (event.clientY - drag.start) / height * 100
    setLayout({ ...layoutRef.current, activityShare: clamp(drag.activityShare + delta, 25, 75) })
  }

  function resizeWithKeyboard(
    event: ReactKeyboardEvent<HTMLDivElement>,
    axis: "horizontal" | "vertical",
    divider: "first" | "second" = "first",
  ) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const current = layoutRef.current
    if (axis === "vertical") {
      const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -3 : 3
      setLayout({ ...current, activityShare: clamp(current.activityShare + delta, 25, 75) })
      return
    }
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -3 : 3
    const first = divider === "first" ? "files" : "preview"
    const second = divider === "first" ? "preview" : "right"
    if (first === "files" && second === "preview") {
      const filesShare = clamp(current.filesShare + delta, 14, 38)
      setLayout({ ...current, filesShare, previewShare: current.filesShare + current.previewShare - filesShare })
    } else if (first === "preview" && second === "right") {
      setLayout({ ...current, previewShare: clamp(current.previewShare + delta, 24, 64) })
    } else if (first === "files" && second === "right") {
      setLayout({ ...current, filesShare: clamp(current.filesShare + delta, 14, 38) })
    }
  }

  return {
    layout,
    gridRef,
    beginHorizontalResize,
    moveHorizontalResize,
    beginVerticalResize,
    moveVerticalResize,
    finishResize: () => { dragRef.current = null },
    resizeWithKeyboard,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (typeof value !== "object" || value === null) return { ...defaultWorkspaceLayout }
  const stored = value as Partial<WorkspaceLayout>
  return {
    filesShare: clamp(typeof stored.filesShare === "number" ? stored.filesShare : defaultWorkspaceLayout.filesShare, 14, 38),
    previewShare: clamp(typeof stored.previewShare === "number" ? stored.previewShare : defaultWorkspaceLayout.previewShare, 24, 64),
    activityShare: clamp(typeof stored.activityShare === "number" ? stored.activityShare : defaultWorkspaceLayout.activityShare, 25, 75),
  }
}
