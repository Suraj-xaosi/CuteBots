"use client"

import type { ReactNode } from "react"
import { X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog"

interface DashboardDialogFrameProps {
  title: string
  onClose: () => void
  className: string
  children: ReactNode
}

export function DashboardDialogFrame({
  title,
  onClose,
  className,
  children,
}: DashboardDialogFrameProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className={className} showCloseButton={false}>
        <header className="flex items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" title="Close" aria-label="Close">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </header>
        <DialogDescription className="sr-only">{title} dialog</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}
