import type { ReactNode } from "react"

import { DiffView } from "@/components/diff-view"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface DiffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  original: string
  modified: string
  /** Extra content between the diff and the footer, such as a note field. */
  children?: ReactNode
  footer: ReactNode
}

export function DiffDialog({
  open,
  onOpenChange,
  title,
  description,
  original,
  modified,
  children,
  footer,
}: DiffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto rounded-lg border">
          <DiffView original={original} modified={modified} />
        </div>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
