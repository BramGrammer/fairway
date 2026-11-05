import { useEffect, useRef } from "react"
import { basicSetup } from "codemirror"
import { unifiedMergeView } from "@codemirror/merge"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { useIsDark } from "@/hooks/use-is-dark"
import { caddyfile } from "@/lib/caddyfile-lang"
import { editorTheme } from "@/lib/editor-theme"

interface DiffViewProps {
  original: string
  modified: string
}

/** Read-only unified diff. Removed lines come from `original`, added lines from `modified`. */
export function DiffView({ original, modified }: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const dark = useIsDark()

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: modified,
        extensions: [
          basicSetup,
          caddyfile,
          editorTheme(dark),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          unifiedMergeView({
            original,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
        ],
      }),
    })
    return () => view.destroy()
  }, [original, modified, dark])

  return <div ref={host} />
}
