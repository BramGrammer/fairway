import { DiffDialog } from "@/components/diff-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface ConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDisk: string
  mine: string
  pending: boolean
  onUseDisk?: () => void
  onOverwrite: () => void
}

/** Shown when the Caddyfile was changed outside the editor since it was loaded. */
export function ConflictDialog({
  open,
  onOpenChange,
  onDisk,
  mine,
  pending,
  onUseDisk,
  onOverwrite,
}: ConflictDialogProps) {
  return (
    <DiffDialog
      open={open}
      onOpenChange={onOpenChange}
      title="The Caddyfile changed outside the editor"
      description="Removed lines are on disk now, added lines are what you are about to write. Overwriting keeps the on-disk version as a snapshot in History."
      original={onDisk}
      modified={mine}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {onUseDisk && (
            <Button variant="secondary" onClick={onUseDisk} disabled={pending}>
              Use the version on disk
            </Button>
          )}
          <Button variant="destructive" onClick={onOverwrite} disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            Overwrite anyway
          </Button>
        </>
      }
    />
  )
}
