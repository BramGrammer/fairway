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
  const warning = dark ? "#fbbf24" : "#b45309"
  const underline = (color: string) =>
    `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="M0 2.5 L1.5 0.5 L3 2.5 L4.5 0.5 L6 2.5" fill="none" stroke="${encodeURIComponent(color)}" stroke-width="1"/></svg>')`
  const errorColor = dark ? "#f87171" : "#dc2626"
  // The gutter icons are Lucide's circle-alert and triangle-alert, drawn the way the lint package draws its own.
  const icon = (color: string, shapes: string) =>
    `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${encodeURIComponent(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>')`
  return [
    EditorView.theme(
      {
        // The surrounding scroll area does the scrolling: the editor is as tall and as wide as its text.
        "&": { minHeight: "100%", width: "max-content", minWidth: "100%", fontSize: "13px", backgroundColor: "transparent" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
          overflow: "visible !important",
          fontFamily: "var(--font-mono)",
          lineHeight: "1.65",
        },
        ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 16px" },
        ".cm-cursor": { borderLeftColor: "var(--foreground)" },
        ".cm-gutters": {
          // Opaque, so text that scrolls sideways passes behind the line numbers instead of through them.
          backgroundColor: "var(--background)",
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
        ".cm-lintRange-error": {
          backgroundImage: underline(errorColor),
          paddingBottom: "2px",
        },
        ".cm-lintRange-warning": { backgroundImage: underline(warning), paddingBottom: "2px" },
        ".cm-lint-marker": { width: "0.9em", height: "0.9em" },
        ".cm-lint-marker-error": {
          content: icon(errorColor, '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
        },
        ".cm-lint-marker-warning": {
          content: icon(warning, '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
        },
        ".cm-gutter-lint": { width: "1.2em" },
        // The icon sits on the middle of its line, not on the text baseline.
        ".cm-gutter-lint .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
        // Other occurrences of the selected word.
        ".cm-selectionMatch": {
          backgroundColor: "color-mix(in oklch, var(--foreground) 14%, transparent)",
          borderRadius: "2px",
        },
        // Matches of the find bar; the selected one stands out.
        ".cm-searchMatch": {
          backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
          borderRadius: "2px",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "color-mix(in oklch, var(--primary) 50%, transparent)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md, 6px)",
          overflow: "hidden",
          boxShadow: "0 4px 12px rgb(0 0 0 / 0.12)",
        },
        ".cm-tooltip-lint": { fontFamily: "var(--font-sans)", fontSize: "12px" },
        ".cm-diagnostic": { padding: "6px 10px", whiteSpace: "pre-wrap", maxWidth: "36rem" },
        ".cm-diagnostic-error": { borderLeft: `3px solid ${dark ? "#f87171" : "#dc2626"}` },
        ".cm-diagnostic-warning": { borderLeft: `3px solid ${warning}` },
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
