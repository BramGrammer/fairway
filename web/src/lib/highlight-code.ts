import { highlightCode, type Highlighter } from "@lezer/highlight"
import { caddyfile } from "./caddyfile-lang"

export interface CodeSpan {
  text: string
  /** CSS class from the highlighter; empty for plain text. */
  className: string
}

/** Splits Caddyfile code into spans, each with the class the highlighter gives it. */
export function highlightCaddyfile(code: string, highlighter: Highlighter): CodeSpan[] {
  const spans: CodeSpan[] = []
  const tree = caddyfile.parser.parse(code)
  highlightCode(
    code,
    tree,
    highlighter,
    (text, className) => spans.push({ text, className }),
    () => spans.push({ text: "\n", className: "" }),
  )
  return spans
}
