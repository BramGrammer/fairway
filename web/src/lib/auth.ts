/** What GET /api/auth/status answers. */
export type AuthStatus =
  | { mode: "none" }
  | { mode: "login"; signedIn: boolean; user: string | null }

export type Gate =
  | { view: "editor"; user: null }
  | { view: "editor"; user: string }
  | { view: "login" }

/** Up to two initials from a username: "jane.doe" -> "JD", "admin" -> "A". */
export function initials(username: string): string {
  const parts = username.trim().split(/[\s._\-@]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const letters = parts.length === 1 ? [...parts[0]].slice(0, 1) : [[...parts[0]][0], [...parts[1]][0]]
  return letters.join("").toUpperCase()
}

/** Decides between the login view and the editor from the status response. */
export function decideGate(status: AuthStatus): Gate {
  if (status.mode === "none") return { view: "editor", user: null }
  if (status.signedIn && status.user) return { view: "editor", user: status.user }
  return { view: "login" }
}

/**
 * Whether an API reply means the session is gone. A 401 from the login request
 * itself is just a wrong password, and the status request answers for itself.
 */
export function isSessionLost(path: string, status: number): boolean {
  if (status !== 401) return false
  return path !== "/api/auth/login" && path !== "/api/auth/status"
}
