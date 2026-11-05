import { StreamLanguage } from "@codemirror/language"

interface State {
  first: boolean
  depth: number
}

/** A small Caddyfile mode: highlighting plus brace-aware indentation. */
export const caddyfile = StreamLanguage.define<State>({
  name: "caddyfile",
  startState: () => ({ first: true, depth: 0 }),
  token(stream, state) {
    if (stream.sol()) state.first = true
    if (stream.eatSpace()) return null
    if (stream.peek() === "#") {
      stream.skipToEnd()
      return "comment"
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/) || stream.match(/^`[^`]*`/)) {
      state.first = false
      return "string"
    }
    if (stream.match(/^\{[$\w.%-]+\}/)) {
      state.first = false
      return "variableName"
    }
    if (stream.match(/^@[\w-]+/)) {
      state.first = false
      return "atom"
    }
    if (stream.match(/^\([\w-]+\)/)) {
      state.first = false
      return "typeName"
    }
    if (stream.match(/^\{/)) {
      state.depth++
      return "bracket"
    }
    if (stream.match(/^\}/)) {
      state.depth = Math.max(0, state.depth - 1)
      return "bracket"
    }
    if (!stream.match(/^[^\s{}"#]+/)) stream.next()
    const wasFirst = state.first
    state.first = false
    return wasFirst ? "keyword" : null
  },
  indent(state, textAfter, context) {
    const closing = /^\s*\}/.test(textAfter) ? 1 : 0
    return Math.max(0, state.depth - closing) * context.unit
  },
  languageData: {
    commentTokens: { line: "#" },
    closeBrackets: { brackets: ["(", "{", '"', "`"] },
    indentOnInput: /^\s*\}$/,
  },
})
