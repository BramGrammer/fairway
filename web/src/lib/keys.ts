const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** The names of the modifier keys on this computer, as they are printed on the keyboard. */
export const modKey = isMac ? "⌘" : "Ctrl"
export const altKey = isMac ? "⌥" : "Alt"
export const shiftKey = "⇧"
