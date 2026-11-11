/** One thing Validation has to say, as the server sends it. */
export interface Finding {
  level: "error" | "warning"
  message: string
  /** 1-based line in the Caddyfile, when known. */
  line?: number
  origin: "caddy" | "rules"
}

export interface Marker {
  from: number
  to: number
  severity: "error" | "warning"
  message: string
}

/** Errors before warnings, then by line; Findings without a line come last in their level. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank = (f: Finding) => (f.level === "error" ? 0 : 1)
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        rank(a.finding) - rank(b.finding) ||
        (a.finding.line ?? Infinity) - (b.finding.line ?? Infinity) ||
        a.index - b.index
    )
    .map((entry) => entry.finding)
}

export interface Summary {
  worst: "error" | "warning"
  title: string
}

/** The headline of the notice: the count and the worst level. Null when there is nothing to report. */
export function summarize(findings: readonly Finding[]): Summary | null {
  const errors = findings.filter((f) => f.level === "error").length
  const warnings = findings.length - errors
  if (findings.length === 0) return null
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const title = [errors > 0 && part(errors, "error"), warnings > 0 && part(warnings, "warning")]
    .filter(Boolean)
    .join(", ")
  return { worst: errors > 0 ? "error" : "warning", title }
}

/** The formatting warning gets a Format button instead of a hand fix. */
export function isFormatting(finding: Finding): boolean {
  return finding.level === "warning" && /not formatted/i.test(finding.message)
}

/** The offset of the start of a 1-based line, or null when the text has no such line. */
export function lineStart(text: string, line: number): number | null {
  if (!Number.isInteger(line) || line < 1) return null
  let offset = 0
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", offset)
    if (next === -1) return null
    offset = next + 1
  }
  return offset
}

/** Editor markers for the Findings that name a line: the line's text without its indent. */
export function toMarkers(findings: readonly Finding[], text: string): Marker[] {
  const markers: Marker[] = []
  for (const finding of sortFindings(findings)) {
    if (finding.line === undefined) continue
    const start = lineStart(text, finding.line)
    if (start === null) continue
    const end = text.indexOf("\n", start)
    const lineEnd = end === -1 ? text.length : end
    const raw = text.slice(start, lineEnd)
    const indent = raw.length - raw.trimStart().length
    const from = start + indent
    const to = Math.max(from, start + raw.trimEnd().length)
    markers.push({ from, to: to === from ? Math.min(from + 1, text.length) : to, severity: finding.level, message: finding.message })
  }
  return markers
}

/** The warnings a Deploy asks you to confirm. The formatting warning has its own button and never counts. */
export function warningsToConfirm(findings: readonly Finding[]): Finding[] {
  return sortFindings(findings.filter((f) => f.level === "warning" && !isFormatting(f)))
}
