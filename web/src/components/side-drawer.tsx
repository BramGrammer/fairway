import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { clampDrawerWidth, DRAWER_STORAGE_KEY, parseStoredWidth } from "@/lib/route-drawer"

function readWidth(): number {
  try {
    return parseStoredWidth(localStorage.getItem(DRAWER_STORAGE_KEY))
  } catch {
    return parseStoredWidth(null)
  }
}

interface SideDrawerProps {
  /** Accessible name of the panel. */
  label: string
  /** The heading, left of the header's actions. */
  title: ReactNode
  /** Buttons between the title and the close button. */
  actions?: ReactNode
  /** Shown between the header and the body, for tabs. */
  tabs?: ReactNode
  /** No padding around the body, for content that runs edge to edge, such as a table. */
  flush?: boolean
  /** The content lays itself out to the height of the drawer and scrolls what needs scrolling; the body does not scroll. */
  fill?: boolean
  onClose: () => void
  children: ReactNode
}

/** Non-modal panel laid over the right edge of its parent, which must be positioned. Resizable, and Escape closes it. */
export function SideDrawer({ label, title, actions, tabs, flush = false, fill = false, onClose, children }: SideDrawerProps) {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(readWidth)

  const resize = useCallback((next: number) => {
    const parent = ref.current?.parentElement?.clientWidth ?? window.innerWidth
    setWidth(clampDrawerWidth(next, parent))
  }, [])

  // Tells whatever else sits over the same area how much of its right edge the drawer covers, so it can stay clear.
  useLayoutEffect(() => {
    const drawer = ref.current
    const parent = drawer?.parentElement
    if (!drawer || !parent) return
    const publish = () => parent.style.setProperty("--side-drawer-width", `${drawer.offsetWidth}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(drawer)
    return () => {
      observer.disconnect()
      parent.style.removeProperty("--side-drawer-width")
    }
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
      aria-label={label}
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
      <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
        {title}
        <div className="ml-auto flex items-center gap-3">
          {actions}
          <Button variant="ghost" size="icon-sm" aria-label="Close drawer" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </div>
      {tabs}
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn(!flush && "px-5 py-4")}>{children}</div>
        </ScrollArea>
      )}
    </section>
  )
}
