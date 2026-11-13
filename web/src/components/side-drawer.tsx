import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  clampDrawerWidth,
  DRAWER_STORAGE_KEY,
  parseStoredWidth,
} from "@/lib/route-drawer"

function readWidth(key: string): number {
  try {
    return parseStoredWidth(localStorage.getItem(key))
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
  /** Sits beside the page as a column of its own, not over it. It needs a flex row as its parent. */
  docked?: boolean
  /** Where the width is remembered; drawers that should not share a width give their own. */
  storageKey?: string
  onClose: () => void
  children: ReactNode
}

/** Non-modal panel laid over the right edge of its parent, which must be positioned. Resizable, and Escape closes it. */
export function SideDrawer({
  label,
  title,
  actions,
  tabs,
  flush = false,
  fill = false,
  docked = false,
  storageKey = DRAWER_STORAGE_KEY,
  onClose,
  children,
}: SideDrawerProps) {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(() => readWidth(storageKey))

  const resize = useCallback((next: number) => {
    const parent = ref.current?.parentElement?.clientWidth ?? window.innerWidth
    setWidth(clampDrawerWidth(next, parent))
  }, [])

  // Tells whatever else sits over the same area how much of its right edge the drawer covers, so it can stay clear.
  useLayoutEffect(() => {
    const drawer = ref.current
    const parent = drawer?.parentElement
    // A docked drawer covers nothing, so there is nothing to stay clear of.
    if (docked || !drawer || !parent) return
    const publish = () =>
      parent.style.setProperty("--side-drawer-width", `${drawer.offsetWidth}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(drawer)
    return () => {
      observer.disconnect()
      parent.style.removeProperty("--side-drawer-width")
    }
  }, [docked])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      // Storage can be unavailable; the width just won't be remembered.
    }
  }, [width, storageKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      // A docked drawer stays beside the page, so Escape in the page must not close it.
      if (docked && !ref.current?.contains(document.activeElement)) return
      onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose, docked])

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
      className={cn(
        "flex flex-col",
        !docked && "bg-card",
        docked
          ? "relative h-svh shrink-0 text-sidebar-foreground"
          : "absolute inset-y-0 right-0 z-10 border-l shadow-[-8px_0_24px_-16px_rgb(0_0_0/0.25)]"
      )}
      style={{ width, maxWidth: docked ? "50%" : "70%" }}
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
      {/* Docked, the header is the height of the page header beside it and starts at the same line, below the inset's margin. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-3",
          docked ? "h-14 pr-3 pl-4 md:mt-2" : "border-b px-5 py-4"
        )}
      >
        {title}
        <div
          className={cn(
            "ml-auto flex items-center",
            docked ? "gap-2" : "gap-3"
          )}
        >
          {actions}
          {/* A docked drawer is closed from the page's own toggle, and by Escape. */}
          {!docked && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close drawer"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          )}
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
