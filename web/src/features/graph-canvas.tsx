import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react"
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

interface View {
  x: number
  y: number
  k: number
}

export interface CanvasHandle {
  /** Scales and positions the content to fit the visible area. */
  fit: () => void
  /** Pans just far enough to bring an element into view, keeping `rightInset` pixels on the right free. */
  reveal: (element: HTMLElement, rightInset: number) => void
}

const MIN_K = 0.25
const MAX_K = 2.5
const MARGIN = 24
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** Zooms to `k` while the point under (px, py) stays where it is. */
const zoomAt = (view: View, k: number, px: number, py: number): View => {
  const next = clamp(k, MIN_K, MAX_K)
  return { k: next, x: px - ((px - view.x) * next) / view.k, y: py - ((py - view.y) * next) / view.k }
}

interface GraphCanvasProps {
  /** Size of the content in pixels. */
  width: number
  height: number
  /** The view fits the content again whenever this changes. */
  fitKey?: string
  onBackgroundClick?: () => void
  ref?: Ref<CanvasHandle>
  children: ReactNode
}

/** A pan and zoom surface: drag to move, scroll to zoom, buttons for zoom and fit. The content keeps its own size. */
export function GraphCanvas({ width, height, fitKey, onBackgroundClick, ref, children }: GraphCanvasProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const size = useRef({ width, height })
  const moved = useRef(false)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [smooth, setSmooth] = useState(false)

  useEffect(() => {
    size.current = { width, height }
  }, [width, height])

  const fit = (animate: boolean) => {
    const box = viewport.current?.getBoundingClientRect()
    if (!box) return
    const { width: w, height: h } = size.current
    const k = clamp(Math.min((box.width - MARGIN) / w, (box.height - MARGIN) / h), 0.4, 1.2)
    setSmooth(animate)
    setView({ k, x: w * k < box.width ? (box.width - w * k) / 2 : 0, y: 0 })
  }

  const zoomBy = (factor: number) => {
    const box = viewport.current?.getBoundingClientRect()
    if (!box) return
    setSmooth(true)
    setView((v) => zoomAt(v, v.k * factor, box.width / 2, box.height / 2))
  }

  useImperativeHandle(ref, () => ({
    fit: () => fit(true),
    reveal: (element, rightInset) => {
      const box = viewport.current?.getBoundingClientRect()
      if (!box) return
      const r = element.getBoundingClientRect()
      const [minX, maxX] = [box.left + MARGIN, box.right - rightInset - MARGIN]
      const [minY, maxY] = [box.top + MARGIN, box.bottom - MARGIN]
      const dx = r.left < minX ? minX - r.left : r.right > maxX ? maxX - r.right : 0
      const dy = r.top < minY ? minY - r.top : r.bottom > maxY ? maxY - r.bottom : 0
      if (dx === 0 && dy === 0) return
      setSmooth(true)
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    },
  }))

  // First fit, and again when the key changes (a new search, say); adding or removing a group keeps the view.
  useEffect(() => {
    fit(false)
  }, [fitKey])

  // Scrolling zooms towards the pointer; this needs a listener that can cancel the page scroll.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = el.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))
      setSmooth(false)
      setView((v) => zoomAt(v, v.k * factor, event.clientX - box.left, event.clientY - box.top))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const origin = { x: event.clientX, y: event.clientY }
    const start = view
    moved.current = false
    const move = (e: PointerEvent) => {
      const dx = e.clientX - origin.x
      const dy = e.clientY - origin.y
      if (!moved.current && Math.hypot(dx, dy) < 4) return
      moved.current = true
      setSmooth(false)
      setView({ ...start, x: start.x + dx, y: start.y + dy })
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      // The click that ends a drag arrives right after; it should not count as a click.
      setTimeout(() => (moved.current = false), 0)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }

  const grid = 24 * view.k
  return (
    <div
      ref={viewport}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      style={{
        backgroundColor: "var(--canvas)",
        backgroundImage: "radial-gradient(circle, color-mix(in oklab, var(--foreground) 14%, transparent) 1px, transparent 1px)",
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={startDrag}
      onClickCapture={(event) => {
        if (moved.current) {
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onClick={onBackgroundClick}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width,
          height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transition: smooth ? "transform 300ms ease" : undefined,
        }}
      >
        {children}
      </div>
      <div
        className="absolute bottom-3 left-3 flex flex-col gap-1"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Button variant="outline" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <PlusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
          <MinusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Fit to view" onClick={() => fit(true)}>
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  )
}
