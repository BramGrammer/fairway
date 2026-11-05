import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"

const TopBarSlot = createContext<HTMLElement | null>(null)

export const TopBarSlotProvider = TopBarSlot.Provider

/** Renders its children into the page's top bar, so each page can put its own actions there. */
export function TopBar({ children }: { children: ReactNode }) {
  const slot = useContext(TopBarSlot)
  return slot ? createPortal(children, slot) : null
}
