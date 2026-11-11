import { useEffect, useRef } from "react"
import { basicSetup } from "codemirror"
import { indentWithTab } from "@codemirror/commands"
import { indentUnit } from "@codemirror/language"
import { lintGutter, setDiagnostics } from "@codemirror/lint"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"

import { ScrollArea } from "@/components/ui/scroll-area"
import { useIsDark } from "@/hooks/use-is-dark"
import type { Marker } from "@/lib/findings"
import { caddyfile } from "@/lib/caddyfile-lang"
import { editorTheme } from "@/lib/editor-theme"

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  onCursor?: (line: number, column: number) => void
  /** Called for Cmd/Ctrl+S. */
  onSave?: () => void
  /** Called for Alt+Shift+F. */
  onFormat?: () => void
  /** Select this range, scroll it into view and focus the editor. A new `seq` repeats the request. */
  reveal?: { from: number; to: number; seq: number } | null
  /** Findings shown at their line: gutter icon, underline, message on hover. */
  markers?: Marker[]
}

export function CodeEditor({ value, onChange, onCursor, onSave, onFormat, reveal, markers }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const theme = useRef(new Compartment())
  const dark = useIsDark()
  const callbacks = useRef({ onChange, onCursor, onSave, onFormat })
  useEffect(() => {
    callbacks.current = { onChange, onCursor, onSave, onFormat }
  })

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          caddyfile,
          lintGutter(),
          // Caddyfiles are conventionally tab-indented; Tab and Shift-Tab indent and outdent.
          indentUnit.of("\t"),
          EditorState.tabSize.of(4),
          Prec.highest(
            keymap.of([
              indentWithTab,
              {
                key: "Shift-Alt-f",
                preventDefault: true,
                run: () => {
                  callbacks.current.onFormat?.()
                  return true
                },
              },
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacks.current.onSave?.()
                  return true
                },
              },
            ])
          ),
          theme.current.of(editorTheme(dark)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              callbacks.current.onCursor?.(line.number, head - line.from + 1)
            }
          }),
        ],
      }),
    })
    view.current = editor
    return () => editor.destroy()
    // The editor is created once; later value and theme changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) {
      // Keep the cursor near where it was, so formatting does not throw it to the top.
      const anchor = Math.min(editor.state.selection.main.head, value.length)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        selection: { anchor },
      })
    }
  }, [value])

  useEffect(() => {
    if (!reveal) return
    // The editor may only just have become visible; wait a frame so it has a size to scroll in.
    const frame = requestAnimationFrame(() => {
      const editor = view.current
      if (!editor) return
      const length = editor.state.doc.length
      const from = Math.min(reveal.from, length)
      editor.dispatch({
        selection: { anchor: from, head: Math.min(reveal.to, length) },
        effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 24 }),
      })
      editor.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const length = editor.state.doc.length
    const diagnostics = (markers ?? [])
      .filter((m) => m.from <= length)
      .map((m) => ({ from: m.from, to: Math.min(m.to, length), severity: m.severity, message: m.message }))
    editor.dispatch(setDiagnostics(editor.state, diagnostics))
  }, [markers])

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(dark)) })
  }, [dark])

  // The editor grows to fit its text and the scroll area scrolls it, so the scrollbars follow the app's theme.
  return (
    <ScrollArea horizontal className="h-full">
      <div ref={host} className="min-h-full" />
    </ScrollArea>
  )
}
