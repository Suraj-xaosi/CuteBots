// All panel sizes live here, so changing a size never means editing three files.
//
// react-resizable-panels v4 (the one that has the `orientation` prop):
//   a string with % is a percentage, a bare number is PIXELS.
// If your version reads numbers as percent instead, drop the "%" signs.
//
// Minimums are chosen from what must always fit without clipping:
//   sidebar: brand block (logo + name + tagline)
//   chat:    the three toolbar controls (labels collapse to icons when narrow)
//   run:     status menu + settings button, and a run-history row
export const PANELS = {
  sidebar: { defaultSize: "22%", minSize: "15%" },
  chat: { defaultSize: "44%", minSize: "30%" },
  run: { defaultSize: "34%", minSize: "20%" },
} as const

export const COLLAPSED_SIZE = "0%"