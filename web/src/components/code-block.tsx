import { useMemo } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { StyleModule } from "style-mod"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useCopy } from "@/hooks/use-copy"
import { useIsDark } from "@/hooks/use-is-dark"
import { highlightCaddyfile } from "@/lib/highlight-code"
import { caddyfileHighlightStyle } from "@/lib/editor-theme"
import { cn } from "cn"

/** A compact read-only block of Caddyfile source, highlighted like the editor, with a copy button. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const dark = useIsDark()
  const { copied, copy } = useCopy()

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
        onClick={() => void copy(code)}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}
