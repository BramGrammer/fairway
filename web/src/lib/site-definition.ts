import { findSiteBlocks } from "./site-blocks"

const MAX_LINES = 60
const MAX_DEPTH = 3

interface Snippet {
  name: string
  text: string
}

/** Finds the top-level `(name) { ... }` blocks, skipping comments and quoted strings. */
function findSnippets(text: string): Snippet[] {
  const tokens: { text: string; start: number; end: number }[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++
    } else {
      const start = i
      if (ch === '"' || ch === "`") {
        i++
        while (i < text.length && text[i] !== ch) i += ch === '"' && text[i] === "\\" ? 2 : 1
        i = Math.min(i + 1, text.length)
      } else {
        while (i < text.length && !/\s/.test(text[i]!)) i++
      }
      tokens.push({ text: text.slice(start, i), start, end: i })
    }
  }

  const snippets: Snippet[] = []
  let depth = 0
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!
    if (token.text === "{") depth++
    else if (token.text === "}") depth = Math.max(0, depth - 1)
    else if (depth === 0 && tokens[t + 1]?.text === "{") {
      const match = /^\(([^()\s]+)\)$/.exec(token.text)
      if (!match) continue
      let level = 0
      let end = text.trimEnd().length
      for (let u = t + 1; u < tokens.length; u++) {
        if (tokens[u]!.text === "{") level++
        else if (tokens[u]!.text === "}" && --level === 0) {
          end = tokens[u]!.end
          break
        }
      }
      snippets.push({ name: match[1]!, text: text.slice(token.start, end) })
    }
  }
  return snippets
}

/** Names of the snippets a block imports, in order; imports of files and globs are left out. */
function importedNames(block: string): string[] {
  const names: string[] = []
  for (const line of block.split("\n")) {
    const match = /^\s*import\s+(\S+)/.exec(line)
    if (match && !/[/*.]/.test(match[1]!)) names.push(match[1]!)
  }
  return names
}

/**
 * The Caddyfile source that defines a host, for display: its Site block followed by the snippets it
 * imports (and those they import, three levels deep), each once, in order of first import. Cut to 60
 * lines, the last of which says how many were left out. Null when the host has no block.
 */
export function siteDefinition(text: string, host: string): string | null {
  if (!text.trim()) return null
  const block = findSiteBlocks(text, host)[0]
  if (!block) return null

  const site = text.slice(block.from, block.to)
  const snippets = new Map(findSnippets(text).map((s) => [s.name, s.text]))
  const parts = [site]
  const seen = new Set<string>()
  const expand = (source: string, depth: number) => {
    for (const name of importedNames(source)) {
      const snippet = snippets.get(name)
      if (snippet === undefined || seen.has(name)) continue
      seen.add(name)
      parts.push(snippet)
      if (depth < MAX_DEPTH) expand(snippet, depth + 1)
    }
  }
  expand(site, 1)

  const lines = parts.join("\n\n").split("\n")
  if (lines.length <= MAX_LINES) return lines.join("\n")
  const kept = lines.slice(0, MAX_LINES - 1)
  kept.push(`# … ${lines.length - kept.length} more lines`)
  return kept.join("\n")
}
