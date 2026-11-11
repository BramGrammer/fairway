import { Fragment } from "react"
import { KeyboardIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { altKey, modKey, shiftKey } from "@/lib/keys"

interface Shortcut {
  label: string
  /** Pressed together, or one after the other when `then` is set. */
  keys: string[]
  then?: boolean
}

const GROUPS: Array<{ title: string; shortcuts: Shortcut[] }> = [
  {
    title: "Caddyfile",
    shortcuts: [
      { label: "Review and deploy", keys: [modKey, "S"] },
      { label: "Format", keys: [shiftKey, altKey, "F"] },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { label: "Indent", keys: ["Tab"] },
      { label: "Outdent", keys: [shiftKey, "Tab"] },
      { label: "Toggle comment", keys: [modKey, "/"] },
      { label: "Undo", keys: [modKey, "Z"] },
      { label: "Redo", keys: modKey === "⌘" ? [modKey, shiftKey, "Z"] : [modKey, "Y"] },
    ],
  },
  {
    title: "Find",
    shortcuts: [
      { label: "Find and replace", keys: [modKey, "F"] },
      { label: "Next match", keys: ["Enter"] },
      { label: "Previous match", keys: [shiftKey, "Enter"] },
      { label: "Select the next occurrence", keys: [modKey, "D"] },
      { label: "Close the find bar", keys: ["Esc"] },
    ],
  },
  {
    title: "Focus",
    shortcuts: [{ label: "Leave the editor", keys: ["Esc", "Tab"], then: true }],
  },
]

/** A button that opens the list of the editor's keyboard shortcuts. */
export function ShortcutsPopover() {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
        <KeyboardIcon data-icon="inline-start" />
        Shortcuts
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>Keyboard shortcuts</PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          {GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
              <dl className="flex flex-col">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-3 py-1">
                    <dt className="text-sm">{shortcut.label}</dt>
                    <dd>
                      {shortcut.then ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {shortcut.keys.map((key, index) => (
                            <Fragment key={key}>
                              {index > 0 && "then"}
                              <Kbd>{key}</Kbd>
                            </Fragment>
                          ))}
                        </span>
                      ) : (
                        <KbdGroup>
                          {shortcut.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
