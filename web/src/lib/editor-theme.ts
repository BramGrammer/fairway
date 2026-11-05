import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags } from "@lezer/highlight"

const palette = {
  light: {
    keyword: "#0b5cad",
    string: "#1a7f37",
    variable: "#b35900",
    atom: "#8250df",
    type: "#bc4c00",
  },
  dark: {
    keyword: "#79b8ff",
    string: "#85e89d",
    variable: "#ffab70",
    atom: "#b392f0",
    type: "#f69d50",
  },
}

/** Editor chrome follows the shadcn CSS variables; syntax colours switch with the theme. */
export function editorTheme(dark: boolean) {
  const colors = dark ? palette.dark : palette.light
  return [
    EditorView.theme(
      {
        "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
          fontFamily: "var(--font-mono)",
          lineHeight: "1.65",
        },
        ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 16px" },
        ".cm-cursor": { borderLeftColor: "var(--foreground)" },
        ".cm-gutters": {
          backgroundColor: "transparent",
          border: "none",
          color: "var(--muted-foreground)",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: "var(--foreground)",
        },
        ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
          {
            backgroundColor:
              "color-mix(in oklch, var(--primary) 22%, transparent) !important",
          },
        ".cm-matchingBracket": {
          backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
          outline: "none",
        },
        ".cm-foldPlaceholder": {
          backgroundColor: "var(--muted)",
          border: "none",
          color: "var(--muted-foreground)",
        },
        ".cm-panels": {
          backgroundColor: "var(--popover)",
          color: "var(--popover-foreground)",
        },
      },
      { dark }
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.keyword, color: colors.keyword },
        { tag: tags.string, color: colors.string },
        { tag: tags.variableName, color: colors.variable },
        { tag: tags.atom, color: colors.atom },
        { tag: tags.typeName, color: colors.type },
        { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
        { tag: tags.bracket, color: "var(--muted-foreground)" },
      ])
    ),
  ]
}
