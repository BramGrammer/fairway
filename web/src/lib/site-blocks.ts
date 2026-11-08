/** A Site's block in the Caddyfile text, as character offsets: from the first address to the closing brace. */
export interface SiteBlock {
  from: number
  to: number
}

interface Token {
  text: string
  start: number
  end: number
}

/** Splits Caddyfile text into whitespace-separated tokens, skipping comments and keeping quoted strings whole. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
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
  return tokens
}

/** The host part of a site address, lowercased; empty for an address that names only a port. */
function addressHost(address: string): string {
  let host = address.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  host = host.replace(/\/.*$/, "")
  // Keep placeholders like {$HOST:default} intact; otherwise drop a trailing :port.
  if (!host.includes("{")) host = host.replace(/:\d+$/, "")
  return host
}

/**
 * Finds the top-level blocks whose address list names the host, in file order. Global options and
 * snippets are skipped, and nothing nested inside a block is considered. "*" stands for a Site that
 * answers for any host: a bare wildcard or a port-only address.
 */
export function findSiteBlocks(text: string, host: string): SiteBlock[] {
  const wanted = addressHost(host)
  const tokens = tokenize(text)
  const found: SiteBlock[] = []
  let header: Token[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.text !== "{") {
      // A new line without a trailing comma ends an address list that never got a block.
      const prev = header[header.length - 1]
      if (prev && !prev.text.endsWith(",") && /\n/.test(text.slice(prev.end, token.start))) header = []
      header.push(token)
      continue
    }

    let depth = 1
    let end = text.trimEnd().length
    while (++i < tokens.length) {
      const inner = tokens[i]!
      if (inner.text === "{") depth++
      else if (inner.text === "}" && --depth === 0) {
        end = inner.end
        break
      }
    }

    const first = header[0]
    const isSnippet = first?.text.startsWith("(") ?? false
    if (first && !isSnippet) {
      const addresses = header.flatMap((t) => t.text.split(",")).filter(Boolean)
      const matches = addresses.some((a) => {
        const h = addressHost(a)
        return wanted === "*" ? h === "" || h === "*" : h === wanted
      })
      if (matches) found.push({ from: first.start, to: end })
    }
    header = []
  }
  return found
}
