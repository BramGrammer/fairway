import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { FileCodeIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  clampDrawerWidth,
  DRAWER_STORAGE_KEY,
  parseStoredWidth,
  type NodeKind,
} from "@/lib/route-drawer"
import { hostFromLabel, requestShowInEditor } from "@/lib/show-in-editor"

const KIND_LABELS: Record<NodeKind, string> = {
  host: "Host",
  rule: "Rule",
  destination: "Destination",
  group: "Group",
}

function readWidth(): number {
  try {
    return parseStoredWidth(localStorage.getItem(DRAWER_STORAGE_KEY))
  } catch {
    return parseStoredWidth(null)
  }
}

interface RouteDrawerProps {
  name: string
  kind: NodeKind
  onClose: () => void
  overview?: ReactNode
}

/** Non-modal panel laid over the right edge of its parent, which must be positioned. */
export function RouteDrawer({ name, kind, overview, onClose }: RouteDrawerProps) {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(readWidth)

  const resize = useCallback((next: number) => {
    const parent = ref.current?.parentElement?.clientWidth ?? window.innerWidth
    setWidth(clampDrawerWidth(next, parent))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(DRAWER_STORAGE_KEY, String(width))
    } catch {
      // Storage can be unavailable; the width just won't be remembered.
    }
  }, [width])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = ref.current?.offsetWidth ?? width
    const move = (e: PointerEvent) => resize(startWidth + startX - e.clientX)
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }

  return (
    <section
      ref={ref}
      aria-label={`${name} details`}
      className="absolute inset-y-0 right-0 z-10 flex flex-col border-l bg-card shadow-[-8px_0_24px_-16px_rgb(0_0_0/0.25)]"
      style={{ width, maxWidth: "70%" }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize drawer"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") resize(width + 24)
          else if (event.key === "ArrowRight") resize(width - 24)
          else return
          event.preventDefault()
        }}
        className="group absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize items-center justify-center outline-none"
      >
        <span className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/50 group-focus-visible:bg-ring" />
      </div>
      <div className="flex shrink-0 items-center gap-3 border-b px-5 pt-5 pb-4">
        <h2 className="min-w-0 truncate font-mono text-lg font-semibold tracking-tight">{name}</h2>
        <Badge variant="secondary" className="h-6 px-2.5 text-xs">
          {KIND_LABELS[kind]}
        </Badge>
        {kind === "host" && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => requestShowInEditor(hostFromLabel(name))}
          >
            <FileCodeIcon data-icon="inline-start" />
            Show in editor
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className={kind === "host" ? undefined : "ml-auto"} aria-label="Close drawer" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{overview}</div>
    </section>
  )
}
