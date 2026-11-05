import { useEffect, useRef } from "react"
import { basicSetup } from "codemirror"
import { indentWithTab } from "@codemirror/commands"
import { indentUnit } from "@codemirror/language"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"

import { useIsDark } from "@/hooks/use-is-dark"
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
}

export function CodeEditor({ value, onChange, onCursor, onSave, onFormat }: CodeEditorProps) {
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
    view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(dark)) })
  }, [dark])

  return <div ref={host} className="h-full" />
}
