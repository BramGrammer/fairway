import { Fragment, useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  HistoryIcon,
  MaximizeIcon,
  RotateCcwIcon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { CodeBlock } from "@/components/code-block"
import { DiffDialog } from "@/components/diff-dialog"
import { DiffView } from "@/components/diff-view"
import { StepTrace } from "@/features/step-trace"
import { ToolbarAction } from "@/components/toolbar-action"
import { TokenPie } from "@/components/token-pie"
import { SideDrawer } from "@/components/side-drawer"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import type { Assistant } from "@/hooks/use-assistant"
import { formatAge } from "@/lib/age"
import type { AiPrice } from "@/lib/ai-settings"
import type { Finding } from "@/lib/findings"
import {
  sendsOnKey,
  splitAnswer,
  splitInline,
  usageBreakdown,
  outdatedReason,
  type AnswerBlock,
  type AssistantMessage,
  type ConversationSummary,
} from "@/lib/assistant"
import { cn } from "@/lib/utils"

interface AssistantPanelProps {
  /** What the model costs per million tokens, when the Owner has said. */
  price: AiPrice | null
  /** The Conversation, held by the page so it outlives the panel. */
  assistant: Assistant
  /** Puts a Proposal's text in the editor as one change. It does not save or deploy. */
  onAccept: (text: string) => void
  onClose: () => void
}

function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {splitInline(line).map((part, j) =>
            part.type === "code" ? (
              <code
                key={j}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
              >
                {part.text}
              </code>
            ) : part.type === "bold" ? (
              <strong key={j}>{part.text}</strong>
            ) : (
              <Fragment key={j}>{part.text}</Fragment>
            )
          )}
        </Fragment>
      ))}
    </>
  )
}

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const

function AnswerTable({
  block,
}: {
  block: Extract<AnswerBlock, { type: "table" }>
}) {
  return (
    <div className="rounded-md border text-xs">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            {block.header.map((cell, column) => (
              <TableHead
                key={column}
                className={cn("h-8 px-2", ALIGN[block.align[column] ?? "left"])}
              >
                <Prose text={cell} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, r) => (
            <TableRow key={r}>
              {row.map((cell, column) => (
                <TableCell
                  key={column}
                  className={cn(
                    "px-2 py-1.5 break-words whitespace-normal",
                    ALIGN[block.align[column] ?? "left"]
                  )}
                >
                  <Prose text={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Answer({ content }: { content: string }) {
  return (
    <div className="flex flex-col gap-2">
      {splitAnswer(content).map((block, i) =>
        block.type === "code" ? (
          <CodeBlock key={i} code={block.code} />
        ) : block.type === "table" ? (
          <AnswerTable key={i} block={block} />
        ) : (
          <p key={i} className="break-words">
            <Prose text={block.text} />
          </p>
        )
      )}
    </div>
  )
}

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {findings.map((finding, i) => (
        <li key={i} className="flex gap-2">
          <span
            className={cn(
              "shrink-0 font-medium",
              finding.level === "error"
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {finding.level}
          </span>
          {finding.line !== undefined && (
            <span className="shrink-0 text-muted-foreground">
              line {finding.line}
            </span>
          )}
          <span className="min-w-0 break-words">{finding.message}</span>
        </li>
      ))}
    </ul>
  )
}

interface DecisionProps {
  /** Whether "Ask again" may be offered: not while a turn runs. */
  canAskAgain: boolean
  onAskAgain: () => void
  onAccept: (text: string) => void
  onDecide: (id: number, status: "accepted" | "rejected") => void
}

/** A Proposal under an answer: a compact difference against the editor, with Accept and Reject. */
function ProposalCard({
  message,
  onAccept,
  onDecide,
  canAskAgain,
  onAskAgain,
}: DecisionProps & { message: AssistantMessage }) {
  const [open, setOpen] = useState(false)
  const proposal = message.proposal!
  // Only the Proposal this page holds, with its real text, can be accepted; one loaded from the server is history.
  const pending = proposal.status === "pending" && proposal.live
  const errors = proposal.findings.filter((f) => f.level === "error")
  const outdated = proposal.status === "outdated"
  // A decided or outdated Proposal is history: its difference is there to read, not to act on.
  const [showHistory, setShowHistory] = useState(false)
  const warnings = proposal.findings.filter((f) => f.level === "warning")
  const acceptLabel = proposal.valid ? "Accept" : "Accept anyway"
  const accept = () => {
    onAccept(proposal.text)
    onDecide(message.id, "accepted")
    setOpen(false)
  }
  const reject = () => {
    onDecide(message.id, "rejected")
    setOpen(false)
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-2"
      aria-label="Proposal"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        Proposal
        {proposal.status === "accepted" && (
          <Badge variant="secondary">Accepted, not deployed</Badge>
        )}
        {proposal.status === "rejected" && (
          <Badge variant="outline">Rejected</Badge>
        )}
        {proposal.status === "replaced" && (
          <Badge variant="outline">Replaced</Badge>
        )}
        {proposal.status === "outdated" && (
          <Badge variant="outline">Outdated</Badge>
        )}
        {pending && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setOpen(true)}
          >
            <MaximizeIcon data-icon="inline-start" />
            Open larger
          </Button>
        )}
      </div>
      {outdated && (
        <div
          className="flex flex-col items-start gap-2 rounded-md border bg-muted/40 p-2"
          role="status"
        >
          <p className="text-xs text-muted-foreground">
            {outdatedReason(proposal)}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={!canAskAgain}
            onClick={onAskAgain}
          >
            <RotateCcwIcon data-icon="inline-start" />
            Ask again
          </Button>
        </div>
      )}
      {proposal.valid ? (
        <p className="text-xs text-muted-foreground">
          Validated in{" "}
          {proposal.attempts === 1
            ? "1 attempt"
            : `${proposal.attempts} attempts`}
        </p>
      ) : (
        <div
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2"
          role="alert"
        >
          <p className="text-xs font-medium text-destructive">
            Caddy does not accept this yet
          </p>
          <FindingList findings={errors} />
        </div>
      )}
      {warnings.length > 0 && <FindingList findings={warnings} />}
      {!pending && (
        <>
          <Button
            variant="ghost"
            size="xs"
            className="self-start"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((shown) => !shown)}
          >
            {showHistory ? "Hide changes" : "Show changes"}
          </Button>
          {showHistory && (
            <>
              <div className="max-h-64 scrollbar-thin overflow-auto rounded-md border text-xs">
                <DiffView
                  original={proposal.baseText}
                  modified={proposal.text}
                />
              </div>
              {!proposal.live && (
                <p className="text-[11px] text-muted-foreground">
                  Secrets are shown as placeholders.
                </p>
              )}
            </>
          )}
        </>
      )}
      {pending && (
        <>
          <div className="max-h-64 scrollbar-thin overflow-auto rounded-md border text-xs">
            <DiffView original={proposal.baseText} modified={proposal.text} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={accept}>
              <CheckIcon data-icon="inline-start" />
              {acceptLabel}
            </Button>
            <Button size="sm" variant="outline" onClick={reject}>
              <XIcon data-icon="inline-start" />
              Reject
            </Button>
          </div>
          <DiffDialog
            open={open}
            onOpenChange={setOpen}
            title="Proposal from the Assistant"
            description="Compared with the editor. Accepting changes the editor only; deploy it yourself."
            original={proposal.baseText}
            modified={proposal.text}
            footer={
              <>
                <Button variant="outline" onClick={reject}>
                  Reject
                </Button>
                <Button onClick={accept}>{acceptLabel}</Button>
              </>
            }
          />
        </>
      )}
    </div>
  )
}

function MessageView({
  message,
  onRetry,
  canRetry,
  running,
  decision,
}: {
  message: AssistantMessage
  /** The turn for this answer is still going. */
  running: boolean
  onRetry: () => void
  canRetry: boolean
  decision: DecisionProps
}) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              {message.content}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  }
  const { problem } = message
  return (
    <Message>
      <MessageContent className="gap-1.5">
        <StepTrace message={message} running={running} />
        {message.content !== "" && <Answer content={message.content} />}
        {message.validating !== undefined && (
          <Trace role="status">
            <TraceLine status="running" className="text-xs">
              <TraceIcon>
                <Spinner />
              </TraceIcon>
              <TraceTitle>
                Validating… (attempt {message.validating})
              </TraceTitle>
            </TraceLine>
          </Trace>
        )}
        {message.proposal && <ProposalCard message={message} {...decision} />}
        {problem && (
          <div
            className={cn(
              "flex items-center gap-2 text-xs",
              problem.kind === "error"
                ? "text-destructive"
                : "text-muted-foreground"
            )}
            role={problem.kind === "error" ? "alert" : undefined}
          >
            <span className="min-w-0 break-words">{problem.text}</span>
            {problem.kind === "error" && canRetry && (
              <Button variant="outline" size="xs" onClick={onRetry}>
                <RotateCcwIcon data-icon="inline-start" />
                Try again
              </Button>
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  )
}

function PastRow({
  item,
  onOpen,
  onDelete,
}: {
  item: ConversationSummary
  onOpen: () => void
  onDelete: () => Promise<boolean>
}) {
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState(false)
  async function remove() {
    setFailed(!(await onDelete()))
    setConfirming(false)
  }
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onOpen}
        >
          <span className="block truncate text-sm font-medium">
            {item.title}
          </span>
          <span className="block text-xs text-muted-foreground">
            {formatAge(item.updatedAt)} ·{" "}
            {item.messages === 1 ? "1 message" : `${item.messages} messages`}
          </span>
        </button>
        {confirming ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void remove()}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${item.title}`}
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {failed && (
        <p className="text-xs text-destructive" role="alert">
          Could not delete it. Try again.
        </p>
      )}
    </li>
  )
}

/** The Conversations kept on the server, newest first. */
function PastConversations({
  assistant,
  onOpened,
}: {
  assistant: Assistant
  onOpened: () => void
}) {
  const { past, refresh, open, remove } = assistant
  useEffect(() => {
    void refresh()
  }, [refresh])
  if (!past || past.state === "loading") {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner className="size-4" />
        Loading Conversations…
      </div>
    )
  }
  if (past.state === "error") {
    return (
      <div className="flex flex-col items-start gap-2 text-sm" role="alert">
        <p className="text-destructive">{past.error}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RotateCcwIcon data-icon="inline-start" />
          Try again
        </Button>
      </div>
    )
  }
  if (past.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Conversations yet. They are kept for 30 days after the last message,
        with secrets replaced.
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y" aria-label="Conversations">
      {past.items.map((item) => (
        <PastRow
          key={item.id}
          item={item}
          onOpen={() =>
            void open(item.id).then((opened) => opened && onOpened())
          }
          onDelete={() => remove(item.id)}
        />
      ))}
    </ul>
  )
}

/** The Assistant, a sidebar on the right of the application: ask about the Caddyfile in the editor and read a streamed answer, or accept a Proposal into the editor. */
export function AssistantPanel({
  assistant,
  price,
  onAccept,
  onClose,
}: AssistantPanelProps) {
  const {
    messages,
    busy,
    opening,
    send,
    askAgain,
    retry,
    stop,
    reset,
    decide,
    restore,
    hasConversation,
  } = assistant
  const [draft, setDraft] = useState("")
  const [showPast, setShowPast] = useState(false)
  const usage = usageBreakdown(messages)
  const last = messages[messages.length - 1]
  const waiting =
    busy &&
    last?.role === "assistant" &&
    last.content === "" &&
    !last.steps?.length

  useEffect(() => {
    restore()
  }, [restore])

  function submit() {
    if (draft.trim() === "" || busy) return
    send(draft)
    setDraft("")
  }

  return (
    <SideDrawer
      label="Assistant"
      fill
      docked
      storageKey="fairway:assistant-width"
      onClose={onClose}
      title={
        <h2 className="font-heading font-medium">
          {showPast ? "Conversations" : "Assistant"}
        </h2>
      }
      actions={
        <>
          <ToolbarAction
            label={showPast ? "Back to the Conversation" : "Past Conversations"}
            variant="ghost"
            onClick={() => setShowPast((shown) => !shown)}
          >
            {showPast ? <ArrowLeftIcon /> : <HistoryIcon />}
          </ToolbarAction>
          {(hasConversation || showPast) && (
            <ToolbarAction
              label="New Conversation"
              variant="ghost"
              onClick={() => {
                reset()
                setShowPast(false)
              }}
            >
              <SquarePenIcon />
            </ToolbarAction>
          )}
        </>
      }
    >
      {!showPast && !opening && messages.length > 0 ? (
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="gap-4 px-4 py-4">
                {messages.map((message, i) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={String(message.id)}
                    scrollAnchor={message.role === "user"}
                  >
                    <MessageView
                      message={message}
                      onRetry={retry}
                      canRetry={!busy && i === messages.length - 1}
                      running={busy && i === messages.length - 1}
                      decision={{
                        onAccept,
                        onDecide: decide,
                        canAskAgain: !busy,
                        onAskAgain: askAgain,
                      }}
                    />
                  </MessageScrollerItem>
                ))}
                {waiting && (
                  <MessageScrollerItem>
                    <Marker role="status">
                      <MarkerIcon>
                        <Spinner />
                      </MarkerIcon>
                      <MarkerContent>Thinking…</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : (
        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-4 py-4">
          {showPast ? (
            <PastConversations
              assistant={assistant}
              onOpened={() => setShowPast(false)}
            />
          ) : opening ? (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" />
              Opening the Conversation…
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ask what a Site does or why a Finding is there. The Assistant
              reads the Caddyfile as it is in the editor, with its Findings. It
              can answer, and offer a change as a Proposal that you accept or
              reject. Nothing is deployed until you deploy it. Conversations are
              kept for 30 days, with secrets replaced.
            </p>
          )}
        </div>
      )}
      <div className="shrink-0 px-4 pt-2 pb-3">
        <InputGroup className="rounded-2xl bg-card dark:bg-card">
          <InputGroupTextarea
            aria-label="Message to the Assistant"
            placeholder="Ask about the Caddyfile"
            className="max-h-40 min-h-12 px-4 pt-3 pb-1 text-sm"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                sendsOnKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                })
              ) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-2 px-3 pb-3">
            <TokenPie usage={usage} price={price} />
            {busy ? (
              <InputGroupButton
                variant="outline"
                size="icon-sm"
                aria-label="Stop"
                className="ml-auto rounded-full"
                onClick={stop}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                variant="default"
                size="icon-sm"
                aria-label="Send"
                className="ml-auto rounded-full"
                onClick={submit}
                disabled={draft.trim() === ""}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </SideDrawer>
  )
}
