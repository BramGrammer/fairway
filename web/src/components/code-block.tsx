import { useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { StyleModule } from "style-mod"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useIsDark } from "@/hooks/use-is-dark"
import { highlightCaddyfile } from "@/lib/highlight-code"
import { caddyfileHighlightStyle } from "@/lib/editor-theme"
import { cn } from "cn"

/** A compact read-only block of Caddyfile source, highlighted like the editor, with a copy button. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const dark = useIsDark()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const content = useMemo(() => {
    try {
      const style = caddyfileHighlightStyle(dark)
      if (style.module) StyleModule.mount(document, style.module)
      return highlightCaddyfile(code, style).map((span, i) =>
        span.className ? (
          <span key={i} className={span.className}>
            {span.text}
          </span>
        ) : (
          span.text
        )
      )
    } catch {
      return code
    }
  }, [code, dark])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be refused; there is nothing useful to show.
    }
  }

  return (
    <div className={cn("relative rounded-md border bg-muted/50", className)}>
      <ScrollArea horizontal autoHide className="max-h-64 rounded-[inherit]">
        <pre className="max-h-64 w-max min-w-full p-3 pr-10 font-mono text-xs leading-relaxed">{content}</pre>
      </ScrollArea>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copy"
        className="absolute top-1.5 right-1.5 text-muted-foreground"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}
