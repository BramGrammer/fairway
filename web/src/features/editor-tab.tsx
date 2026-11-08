import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  RocketIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react"

import { CodeEditor } from "@/components/code-editor"
import { ConflictDialog } from "@/components/conflict-dialog"
import { DiffDialog } from "@/components/diff-dialog"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  /** The warning says the file is not formatted, so offer to fix it. */
  canFormat?: boolean
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
  const [validating, setValidating] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [conflictText, setConflictText] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [deploying, setDeploying] = useState(false)
  const [formatting, setFormatting] = useState(false)

  const [reveal, setReveal] = useState<{ from: number; to: number; seq: number } | null>(null)

  const dirty = text !== baseText

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
    if (!body.ok) {
      setNotice({ kind: "error", title: "Caddy rejected this Caddyfile", body: body.error })
      return false
    }
    const warnings = body.warnings
      .map((w) => `${w.line ? `Line ${w.line}: ` : ""}${w.message}`)
      .join("\n")
    setNotice({
      kind: "ok",
      title: warnings ? "Valid, with warnings" : "Valid",
      body: warnings || undefined,
      canFormat: /not formatted/i.test(warnings),
    })
    return true
  }

  async function format() {
    setFormatting(true)
    const { body } = await api<FormatResult>("/api/format", { text })
    setFormatting(false)
    if (!body.ok) {
      setNotice({ kind: "error", title: "Could not format the Caddyfile", body: body.error })
      return
    }
    if (!body.changed) {
      toast.info("Already formatted")
      return
    }
    onTextChange(body.text)
    setNotice(null)
    toast.success("Formatted", { description: "Whitespace and indentation were normalised." })
  }

  async function review() {
    if (!dirty || (await validate()) === false) return
    setNote("")
    setReviewOpen(true)
  }

  async function deploy(force: boolean) {
    setDeploying(true)
    const { body } = await api<DeployResult>("/api/deploy", { text, baseHash, force, note })
    setDeploying(false)
    if (body.ok) {
      setReviewOpen(false)
      setConflictText(null)
      setNotice(null)
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
    setNotice({ kind: "error", title: describeFailure(body), body: body.message })
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
              setNotice(null)
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
          {notice.canFormat && (
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void format()} disabled={formatting}>
                <WandSparklesIcon data-icon="inline-start" />
                Format now
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          value={text}
          onChange={onTextChange}
          onCursor={(line, column) => setCursor({ line, column })}
          onSave={() => void review()}
          onFormat={() => void format()}
          reveal={reveal}
        />
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
            <Button onClick={() => void deploy(false)} disabled={deploying}>
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
        <Field>
          <FieldLabel htmlFor="deploy-note">Note (optional)</FieldLabel>
          <Input
            id="deploy-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What changed and why"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !deploying) void deploy(false)
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
          setNotice(null)
          toast.info("Loaded the version from disk. Your edits were discarded.")
        }}
        onOverwrite={() => void deploy(true)}
      />
    </div>
  )
}
