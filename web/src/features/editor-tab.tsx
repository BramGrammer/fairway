import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  PanelRightOpenIcon,
  RocketIcon,
  TriangleAlertIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react"

import { CodeEditor } from "@/components/code-editor"
import { ConflictDialog } from "@/components/conflict-dialog"
import { DiffDialog } from "@/components/diff-dialog"
import { FindingsDrawer } from "@/features/findings-drawer"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { TopBar } from "@/components/top-bar"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  describeFailure,
  type DeployResult,
  type FormatResult,
  type ValidateResult,
} from "@/lib/api"
import {
  lineStart,
  sortFindings,
  summarize,
  toMarkers,
  warningsToConfirm,
  type Finding,
} from "@/lib/findings"
import { useLiveFindings } from "@/hooks/use-live-findings"
import { onShowInEditor } from "@/lib/show-in-editor"
import { findSiteBlocks } from "@/lib/site-blocks"

interface EditorTabProps {
  /** The tab stays mounted while hidden; only the visible one fills the top bar. */
  active: boolean
  text: string
  onTextChange: (text: string) => void
  baseText: string
  baseHash: string
  onDeployed: (text: string, hash: string) => void
  onUseDisk: () => Promise<void>
}

interface Notice {
  kind: "ok" | "error"
  title: string
  body?: string
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const modKey = isMac ? "⌘" : "Ctrl"
const altKey = isMac ? "⌥" : "Alt"

export function EditorTab({
  active,
  text,
  onTextChange,
  baseText,
  baseHash,
  onDeployed,
  onUseDisk,
}: EditorTabProps) {
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [findingsOpen, setFindingsOpen] = useState(false)
  /** What the last Validate found; shown in the editor and as the summary above it. */
  const [findings, setFindings] = useState<Finding[]>([])
  const [validating, setValidating] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [conflictText, setConflictText] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [deploying, setDeploying] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [seenKey, setSeenKey] = useState<string | null>(null)

  const [reveal, setReveal] = useState<{ from: number; to: number; seq: number } | null>(null)

  const dirty = text !== baseText
  const sorted = useMemo(() => sortFindings(findings), [findings])
  const summary = summarize(sorted)
  const markers = useMemo(() => toMarkers(findings, text), [findings, text])

  // Quiet: a live answer only replaces the Findings; it never shows "Valid". A "Valid" notice is stale once Findings appear.
  useLiveFindings(text, (live) => {
    setFindings(live)
    if (live.length > 0) setNotice((current) => (current?.kind === "ok" ? null : current))
  })

  const toConfirm = useMemo(() => warningsToConfirm(findings), [findings])
  // The tick belongs to the warnings it was given for: if they change while the dialog is open, it has to be given again.
  const confirmKey = toConfirm.map((finding) => `${finding.line ?? ""}:${finding.message}`).join("\n")
  const seenWarnings = seenKey === confirmKey

  function showNotice(next: Notice | null) {
    setFindings([])
    setNotice(next)
  }

  function jumpTo(line: number) {
    const from = lineStart(text, line)
    if (from === null) return
    setReveal((prev) => ({ from, to: from, seq: (prev?.seq ?? 0) + 1 }))
  }

  useEffect(
    () =>
      onShowInEditor((host) => {
        const blocks = findSiteBlocks(text, host)
        const first = blocks[0]
        if (!first) {
          toast.error(`No block for ${host} in the Caddyfile`)
          return
        }
        setReveal((prev) => ({ ...first, seq: (prev?.seq ?? 0) + 1 }))
        if (blocks.length > 1) {
          toast.info(`${blocks.length} blocks match ${host}`, { description: "Selected the first one." })
        }
      }),
    [text]
  )

  async function validate(): Promise<boolean> {
    setValidating(true)
    const { body } = await api<ValidateResult>("/api/validate", { text })
    setValidating(false)
    if (body.findings.length === 0) {
      showNotice({ kind: "ok", title: "Valid" })
    } else {
      showNotice(null)
      setFindings(body.findings)
    }
    return body.ok
  }

  async function format() {
    setFormatting(true)
    const { body } = await api<FormatResult>("/api/format", { text })
    setFormatting(false)
    if (!body.ok) {
      showNotice({ kind: "error", title: "Could not format the Caddyfile", body: body.error })
      return
    }
    if (!body.changed) {
      toast.info("Already formatted")
      return
    }
    onTextChange(body.text)
    showNotice(null)
    toast.success("Formatted", { description: "Whitespace and indentation were normalised." })
  }

  async function review() {
    if (!dirty || (await validate()) === false) return
    setNote("")
    setSeenKey(null)
    setReviewOpen(true)
  }

  async function deploy(force: boolean) {
    setDeploying(true)
    const { body } = await api<DeployResult>("/api/deploy", { text, baseHash, force, note })
    setDeploying(false)
    if (body.ok) {
      setReviewOpen(false)
      setConflictText(null)
      showNotice(null)
      onDeployed(text, body.hash)
      toast.success(
        body.unchanged
          ? "Reloaded. Identical to the latest version, so nothing new was recorded."
          : `Deployed as version ${body.revision.id}`,
        { description: "Caddy reloaded with no downtime." }
      )
      return
    }
    setReviewOpen(false)
    if (body.code === "conflict") {
      setConflictText(body.currentText ?? "")
      return
    }
    setConflictText(null)
    showNotice({ kind: "error", title: describeFailure(body), body: body.message })
  }

  return (
    <div className="flex h-full flex-col">
      {active && (
        <TopBar>
          {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
          <Button
            variant="ghost"
            onClick={() => {
              onTextChange(baseText)
              showNotice(null)
            }}
            disabled={!dirty}
          >
            <Undo2Icon data-icon="inline-start" />
            Discard changes
          </Button>
          <Button variant="outline" onClick={() => void format()} disabled={formatting}>
            {formatting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <WandSparklesIcon data-icon="inline-start" />
            )}
            Format
          </Button>
          <Button variant="outline" onClick={validate} disabled={validating}>
            {validating ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <CircleCheckIcon data-icon="inline-start" />
            )}
            Validate
          </Button>
          <Button onClick={review} disabled={!dirty || validating}>
            <RocketIcon data-icon="inline-start" />
            Review &amp; deploy
          </Button>
        </TopBar>
      )}

      {summary && (
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm">
          {summary.worst === "error" ? (
            <CircleAlertIcon className="size-4 text-destructive" />
          ) : (
            <TriangleAlertIcon className="size-4" />
          )}
          <span className="font-medium">{summary.title}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            aria-expanded={findingsOpen}
            onClick={() => setFindingsOpen((open) => !open)}
          >
            <PanelRightOpenIcon data-icon="inline-start" />
            Details
          </Button>
        </div>
      )}

      {notice && (
        <Alert
          variant={notice.kind === "error" ? "destructive" : "default"}
          className="max-h-48 shrink-0 overflow-auto rounded-none border-x-0 border-t-0"
        >
          {notice.kind === "error" ? <CircleAlertIcon /> : <CircleCheckIcon />}
          <AlertTitle>{notice.title}</AlertTitle>
          {notice.body && (
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {notice.body}
            </AlertDescription>
          )}
        </Alert>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          value={text}
          onChange={onTextChange}
          onCursor={(line, column) => setCursor({ line, column })}
          onSave={() => void review()}
          onFormat={() => void format()}
          reveal={reveal}
          markers={markers}
        />
        {summary && findingsOpen && (
          <FindingsDrawer
            findings={sorted}
            onJump={jumpTo}
            onFormat={() => void format()}
            formatting={formatting}
            onClose={() => setFindingsOpen(false)}
          />
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          Ln {cursor.line}, Col {cursor.column} · Tabs
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <Kbd>Tab</Kbd> indent <Kbd>⇧ Tab</Kbd> outdent
          </span>
          <span className="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>⇧</Kbd>
              <Kbd>{altKey}</Kbd>
              <Kbd>F</Kbd>
            </KbdGroup>
            format
          </span>
          <span className="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>S</Kbd>
            </KbdGroup>
            review &amp; deploy
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd> then <Kbd>Tab</Kbd> leaves the editor
          </span>
        </span>
      </div>

      <DiffDialog
        open={reviewOpen}
        onOpenChange={(open) => !deploying && setReviewOpen(open)}
        title="Review and deploy"
        description="Validated by Caddy. Removed lines are in red, added lines in green."
        original={baseText}
        modified={text}
        footer={
          <>
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={deploying}>
              Cancel
            </Button>
            <Button
              onClick={() => void deploy(false)}
              disabled={deploying || (toConfirm.length > 0 && !seenWarnings)}
            >
              {deploying ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RocketIcon data-icon="inline-start" />
              )}
              Deploy
            </Button>
          </>
        }
      >
        {toConfirm.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
              <TriangleAlertIcon className="size-4 shrink-0" />
              {toConfirm.length === 1 ? "1 warning" : `${toConfirm.length} warnings`}
            </div>
            <ul className="flex max-h-32 flex-col gap-1 overflow-auto text-xs">
              {toConfirm.map((finding, index) => (
                <li key={index} className="flex flex-wrap gap-x-2">
                  {finding.line !== undefined && (
                    <span className="font-mono text-muted-foreground">Line {finding.line}</span>
                  )}
                  <span className="min-w-0 break-words">{finding.message}</span>
                </li>
              ))}
            </ul>
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
              <Checkbox checked={seenWarnings} onCheckedChange={(checked) => setSeenKey(checked === true ? confirmKey : null)} />
              I&apos;ve seen {toConfirm.length === 1 ? "this" : "these"}
            </label>
          </div>
        )}
        <Field>
          <FieldLabel htmlFor="deploy-note">Note (optional)</FieldLabel>
          <Input
            id="deploy-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What changed and why"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !deploying && (toConfirm.length === 0 || seenWarnings)) void deploy(false)
            }}
          />
        </Field>
      </DiffDialog>

      <ConflictDialog
        open={conflictText !== null}
        onOpenChange={(open) => !open && setConflictText(null)}
        onDisk={conflictText ?? ""}
        mine={text}
        pending={deploying}
        onUseDisk={async () => {
          setConflictText(null)
          await onUseDisk()
          showNotice(null)
          toast.info("Loaded the version from disk. Your edits were discarded.")
        }}
        onOverwrite={() => void deploy(true)}
      />
    </div>
  )
}
