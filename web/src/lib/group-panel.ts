/** An expanded group is one panel: a header, then its members as compact rows, with the rest folded into "Show N more". */

/** Members shown before the rest are folded away. */
export const PANEL_ROWS = 6
export const PANEL_PAD = 8
export const PANEL_HEADER_H = 24
/** Height of the "show more" and "show fewer" rows. */
export const PANEL_ROW_H = 30
export const PANEL_GAP = 4

/** The members to draw as rows, and those folded into the "more" row. A member that is selected is always drawn. */
export function splitMembers(members: string[], keep: string | null, all = false): { shown: string[]; hidden: string[] } {
  if (all) return { shown: members, hidden: [] }
  const shown = members.slice(0, PANEL_ROWS)
  if (keep !== null && members.includes(keep) && !shown.includes(keep)) shown.push(keep)
  return { shown, hidden: members.filter((member) => !shown.includes(member)) }
}

/** Where each row's middle sits, measured from the top of the panel, and the panel's height. Rows may differ in height. */
export function panelRows(heights: number[]): { centers: number[]; height: number } {
  let y = 1 + PANEL_PAD + PANEL_HEADER_H + PANEL_GAP
  const centers = heights.map((h) => {
    const center = y + h / 2
    y += h + PANEL_GAP
    return center
  })
  // One border on each side, and no gap after the last row.
  return { centers, height: y - PANEL_GAP + PANEL_PAD + 1 }
}
