import { Bot } from "lucide-react"

// Server component. Black block from the mockup (primary tokens, so it stays
// black and white in light and dark mode). shrink-0: the list below takes the
// remaining height, this never grows or shrinks.
export function BrandHeader() {
  return (
    <header className="flex shrink-0 items-center gap-3 rounded-xl bg-primary px-4 py-4 text-primary-foreground">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-foreground/15">
        <Bot className="size-6" aria-hidden />
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight">CuteBots</h1>
        <p className="truncate text-xs text-primary-foreground/70">Build. Run. Automate.</p>
      </div>
    </header>
  )
}