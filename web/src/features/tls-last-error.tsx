import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import { formatAge } from "@/lib/age"

interface IssuanceError {
  at: number
  message: string
  logger: string
  issuer?: string
}

type Reply = { ok: true; error: IssuanceError | null } | { ok: false; error: string }

/** The last issuance or renewal error Caddy logged for a host. Renders nothing when there is none. */
export function TlsLastError({ host }: { host: string }) {
  const [found, setFound] = useState<IssuanceError | null>(null)

  useEffect(() => {
    let cancelled = false
    api<Reply>(`/api/tls/last-error?host=${encodeURIComponent(host)}`)
      .then((r) => {
        if (!cancelled) setFound(r.body.ok ? r.body.error : null)
      })
      .catch(() => !cancelled && setFound(null))
    return () => {
      cancelled = true
    }
  }, [host])

  if (!found) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium text-destructive">Last issuance error</span>
        <span className="text-xs text-muted-foreground" title={new Date(found.at).toLocaleString()}>
          {formatAge(found.at)}
        </span>
      </div>
      <p className="font-mono text-xs break-words">{found.message}</p>
      <p className="text-xs text-muted-foreground">Read from Caddy's log; it clears once a later certificate succeeds.</p>
    </div>
  )
}
