import { LockIcon, LockOpenIcon } from "lucide-react"

import type { Security } from "@/lib/tls-config"

/** A green lock for a host served over HTTPS, an open grey one when it is plain HTTP. */
export function TlsLock({ security }: { security: Security | null }) {
  if (!security) return null
  const Icon = security.kind === "https" ? LockIcon : LockOpenIcon
  return (
    <span role="img" aria-label={security.label} title={security.label} className="shrink-0">
      <Icon className={security.kind === "https" ? "size-3 text-success" : "size-3 text-muted-foreground"} />
    </span>
  )
}
