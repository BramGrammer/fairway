import { useState, type ReactNode } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { CodeBlock } from "@/components/code-block"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { requestShowInEditor } from "@/lib/show-in-editor"
import { siteDefinition } from "@/lib/site-definition"
import { cn } from "@/lib/utils"

interface DefinitionPopoverProps {
  /** The cell content; it becomes a subtle ghost link that opens the popover. */
  children: ReactNode
  title: string
  host: string
  editorText: string
  /** Shown above the definition (e.g. the upstream addresses). */
  intro?: ReactNode
  /** Shown instead of the Caddyfile excerpt when the editor has no block for the host. */
  fallback: ReactNode
  /** Text for the Copy button when there is no Caddyfile excerpt; the excerpt has its own copy button. */
  copyText?: string
  /** Trigger label for assistive tech. */
  label: string
  className?: string
}

/** The popover shared by the Path, Destination and Middleware cells. */
export function DefinitionPopover({
  children,
  title,
  host,
  editorText,
  intro,
  fallback,
  copyText,
  label,
  className,
}: DefinitionPopoverProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const definition = open ? siteDefinition(editorText, host) : null

  const copy = () => {
    navigator.clipboard
      ?.writeText(copyText ?? "")
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" />}
        aria-label={label}
        className={cn(
          "-mx-1.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted",
          className,
        )}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] max-w-[calc(100vw-2rem)]">
        <div className="text-sm font-medium">{title}</div>
        {intro}
        {definition !== null ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <CodeBlock code={definition} />
            <p className="text-xs text-muted-foreground">From the Caddyfile in the editor</p>
          </div>
        ) : (
          fallback
        )}
        <div className="flex items-center justify-end gap-2">
          {definition === null && copyText ? (
            <Button variant="ghost" size="sm" onClick={copy}>
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              requestShowInEditor(host)
            }}
          >
            Show in editor
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Mono, wrapped, scrollable text for the config-derived fallback. */
export function DetailText({ children }: { children: ReactNode }) {
  return (
    <ScrollArea autoHide className="max-h-64 rounded-md bg-muted">
      <pre className="p-2 font-mono text-xs whitespace-pre-wrap">{children}</pre>
    </ScrollArea>
  )
}
