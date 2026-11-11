import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { FileClockIcon, HistoryIcon, Undo2Icon, FilePenLineIcon } from "lucide-react"

import { ConflictDialog } from "@/components/conflict-dialog"
import { TopBar } from "@/components/top-bar"
import { DiffDialog } from "@/components/diff-dialog"
import { DiffView } from "@/components/diff-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  describeFailure,
  type CaddyfileState,
  type DeployResult,
  type RevisionId,
  type RevisionMeta,
} from "@/lib/api"
import { useRouter } from "@/hooks/use-router"
import { cn } from "@/lib/utils"

interface HistoryTabProps {
  /** Unsaved edits in the editor would be replaced by a rollback. */
  dirty: boolean
  onLoadIntoEditor: (text: string) => void
  /** Called after the live Caddyfile changed through a rollback. */
  onRolledBack: () => Promise<void>
}

interface Entry {
  id: RevisionId
  title: string
  subtitle: string
  tag?: string
}

function toEntries(revisions: RevisionMeta[], hasOriginal: boolean): Entry[] {
  const entries: Entry[] = revisions.map((revision) => ({
    id: revision.id,
    title: `Version ${revision.id}`,
    subtitle: [new Date(revision.createdAt).toLocaleString(), revision.note]
      .filter(Boolean)
      .join(" · "),
    tag: revision.kind === "external" ? "Outside edit" : undefined,
  }))
  if (hasOriginal) {
    entries.push({
      id: "original",
      title: "Original",
      subtitle: "The Caddyfile before the editor first changed it",
      tag: "Kept forever",
    })
  }
  return entries
}

export function HistoryTab({ dirty, onLoadIntoEditor, onRolledBack }: HistoryTabProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const { params, openPanel, replaceParams, closePanel } = useRouter()
  const revision = params.revision
  const [loaded, setLoaded] = useState<{ entry: Entry; text: string } | null>(null)
  // Only a revision that the URL names is shown; the URL is the source of truth.
  const selected = loaded && String(loaded.entry.id) === revision ? loaded : null
  const [live, setLive] = useState<CaddyfileState | null>(null)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [conflictText, setConflictText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const loadEntries = useCallback(async () => {
    const { body } = await api<{ revisions: RevisionMeta[]; hasOriginal: boolean }>(
      "/api/revisions"
    )
    setEntries(toEntries(body.revisions, body.hasOriginal))
  }, [])

  useEffect(() => {
    let active = true
    api<{ revisions: RevisionMeta[]; hasOriginal: boolean }>("/api/revisions").then(({ body }) => {
      if (active) setEntries(toEntries(body.revisions, body.hasOriginal))
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const entry = revision === undefined ? undefined : entries?.find((item) => String(item.id) === revision)
    if (!entry) return
    let active = true
    Promise.all([api<{ text: string }>(`/api/revisions/${entry.id}`), api<CaddyfileState>("/api/caddyfile")]).then(
      ([text, current]) => {
        if (!active) return
        setLoaded({ entry, text: text.body.text })
        setLive(current.body)
      }
    )
    return () => {
      active = false
    }
  }, [revision, entries])

  /** Opening a revision pushes an entry, so Back closes it; moving to another one replaces. */
  function select(entry: Entry) {
    const next = { revision: String(entry.id) }
    if (revision === undefined) openPanel(next)
    else replaceParams(next)
  }

  async function rollback(force: boolean) {
    if (!selected || !live) return
    setPending(true)
    const { body } = await api<DeployResult>("/api/rollback", {
      id: selected.entry.id,
      baseHash: live.hash,
      force,
    })
    setPending(false)
    setRollbackOpen(false)
    if (body.ok) {
      setConflictText(null)
      toast.success(`Rolled back to ${selected.entry.title.toLowerCase()}`, {
        description: "Caddy reloaded with no downtime.",
      })
      await onRolledBack()
      await loadEntries()
      closePanel(["revision"])
      return
    }
    if (body.code === "conflict") {
      setConflictText(body.currentText ?? "")
      return
    }
    toast.error(describeFailure(body), { description: body.message })
  }

  if (entries === null) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-14 w-full bg-card" />
        <Skeleton className="h-14 w-full bg-card" />
        <Skeleton className="h-14 w-full bg-card" />
      </div>
    )
  }

  return (
    <>
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize="28%" minSize="20%" maxSize="45%" className="bg-card">
        <ScrollArea className="h-full">
          {entries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HistoryIcon />
                </EmptyMedia>
                <EmptyTitle>No history yet</EmptyTitle>
                <EmptyDescription>Versions appear here after you deploy.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col">
              {entries.map((entry) => (
                <Button
                  key={entry.id}
                  variant="ghost"
                  onClick={() => select(entry)}
                  className={cn(
                    "h-auto w-full flex-col items-start gap-0.5 rounded-none border-b-border px-4 py-2.5 text-left whitespace-normal hover:bg-secondary",
                    selected?.entry.id === entry.id &&
                      "bg-secondary shadow-[inset_2px_0_0_var(--primary)]"
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {entry.title}
                    {entry.tag && <Badge variant="outline">{entry.tag}</Badge>}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {entry.subtitle}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="72%">
        {selected && live ? (
          <div className="flex h-full flex-col">
            <TopBar>
              <Button variant="outline" onClick={() => onLoadIntoEditor(selected.text)}>
                <FilePenLineIcon data-icon="inline-start" />
                Load into editor
              </Button>
              <Button onClick={() => setRollbackOpen(true)}>
                <Undo2Icon data-icon="inline-start" />
                Roll back to this
              </Button>
            </TopBar>
            <ScrollArea horizontal className="min-h-0 flex-1">
              <DiffView original={live.text} modified={selected.text} />
            </ScrollArea>
          </div>
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileClockIcon />
              </EmptyMedia>
              <EmptyTitle>Select a version</EmptyTitle>
              <EmptyDescription>
                Compare it with the live Caddyfile, then roll back in one click.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>

      {selected && live && (
        <>
          <DiffDialog
            open={rollbackOpen}
            onOpenChange={(open) => !pending && setRollbackOpen(open)}
            title={`Roll back to ${selected.entry.title.toLowerCase()}`}
            description={
              dirty
                ? "Validated and reloaded by Caddy. You have unsaved edits in the editor, and they will be replaced."
                : "Validated and reloaded by Caddy. Removed lines leave the live Caddyfile, added lines join it."
            }
            original={live.text}
            modified={selected.text}
            footer={
              <>
                <Button variant="outline" onClick={() => setRollbackOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button onClick={() => void rollback(false)} disabled={pending}>
                  {pending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Undo2Icon data-icon="inline-start" />
                  )}
                  Roll back
                </Button>
              </>
            }
          />
          <ConflictDialog
            open={conflictText !== null}
            onOpenChange={(open) => !open && setConflictText(null)}
            onDisk={conflictText ?? ""}
            mine={selected.text}
            pending={pending}
            onOverwrite={() => void rollback(true)}
          />
        </>
      )}
    </>
  )
}
