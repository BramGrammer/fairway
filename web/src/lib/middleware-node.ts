import type { Chip } from "./api"

export interface StepInfo {
  title: string
  /** Short values to show as badges, like country codes or encodings. */
  items: string[]
  /** A sentence to show instead when the detail is not a list. */
  note?: string
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A middleware's title, and what to show under it: its values as badges when they form a list, else a short note. */
export function describeStep(chip: Chip): StepInfo {
  const colon = chip.label.indexOf(": ")
  const title = capitalise(colon === -1 ? chip.label : chip.label.slice(0, colon))

  // The label carries a shortened list ("NL BE +3"); the detail has all of it.
  const parts = chip.detail
    ? chip.detail.replace(/^Only these countries are allowed:\s*/, "").split(/,\s*/)
    : colon === -1
      ? []
      : chip.label
          .slice(colon + 2)
          .split(/\s+/)
          .filter((part) => !/^\+\d+$/.test(part))
  const source = parts.join(", ")
  if (!source) return { title, items: [] }
  const isList = parts.every((part) => part.length > 0 && part.length <= 22 && part.split(" ").length <= 2)
  return isList ? { title, items: parts } : { title, items: [], note: source }
}

const BADGE_CHAR = 5.8
const BADGE_PADDING = 14
const BADGE_GAP = 4
const MORE_WIDTH = 30

/** How many badges fit in `available` pixels; a "+N" badge takes the place of the rest. */
export function fitBadges(items: string[], available: number): { shown: string[]; hidden: number } {
  const shown: string[] = []
  let used = 0
  for (const [i, item] of items.entries()) {
    const width = item.length * BADGE_CHAR + BADGE_PADDING + (shown.length > 0 ? BADGE_GAP : 0)
    const reserve = i < items.length - 1 ? BADGE_GAP + MORE_WIDTH : 0
    if (used + width + reserve > available) break
    used += width
    shown.push(item)
  }
  return { shown, hidden: items.length - shown.length }
}

/** Nodes with a second row are taller than those with only a title. */
export const stepHeight = (chip: Chip) => {
  const info = describeStep(chip)
  return info.items.length > 0 || info.note ? 60 : 40
}
