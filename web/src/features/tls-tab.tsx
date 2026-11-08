import { useEffect, useState } from "react"

import { LockIcon, LockOpenIcon, ShieldCheckIcon, type LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import type { NodeKind } from "@/lib/route-drawer"
import { CertificateProbe } from "./tls-probe"

import { TlsLastError } from "./tls-last-error"

type TlsState =
  | "managed"
  | "on-demand"
  | "internal"
  | "manual"
  | "http-only"
  | "off"
  | "wildcard-covered"
  | "none"

interface Issuer {
  name: string
  challenges: ("http" | "tls-alpn" | "dns")[]
  dnsProvider?: string
}

interface HostTls {
  host: string
  state: TlsState
  coveredBy?: string
  issuers: Issuer[]
  reason?: string
}

type TlsReply =
  | { ok: true; sites: { hosts: HostTls[] }[] }
  | { ok: false; error: string }

const STATE_LABELS: Record<TlsState, { label: string; detail: string }> = {
  managed: { label: "Managed by Caddy", detail: "Caddy obtains and renews this Certificate." },
  "on-demand": {
    label: "On-demand",
    detail: "Caddy obtains the Certificate on the first request for this name.",
  },
  internal: {
    label: "Internal issuer",
    detail: "Signed by Caddy's own CA, so browsers do not trust it by default.",
  },
  manual: { label: "Supplied manually", detail: "The Certificate is loaded from files or storage, not managed by Caddy." },
  "http-only": { label: "HTTP only", detail: "Served over plain HTTP, so there is no Certificate." },
  off: { label: "Not managed", detail: "Automatic HTTPS is turned off for this host." },
  "wildcard-covered": { label: "Covered by wildcard", detail: "A wildcard Certificate already covers this host." },
  none: { label: "No hostname", detail: "This route matches no hostname, so there is no Certificate to manage." },
}

const PROBEABLE: TlsState[] = ["managed", "internal", "manual"]

const CHALLENGE_LABELS = { http: "HTTP", "tls-alpn": "TLS-ALPN", dns: "DNS" } as const

const STATE_ICONS: Record<TlsState, LucideIcon> = {
  managed: ShieldCheckIcon,
  "on-demand": ShieldCheckIcon,
  internal: LockIcon,
  manual: LockIcon,
  "http-only": LockOpenIcon,
  off: LockOpenIcon,
  "wildcard-covered": ShieldCheckIcon,
  none: LockOpenIcon,
}

function HostBlock({ entry }: { entry: HostTls }) {
  const state = STATE_LABELS[entry.state]
  const Icon = STATE_ICONS[entry.state]
  const secure = ["managed", "wildcard-covered", "on-demand", "internal", "manual"].includes(entry.state)
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${secure ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
          >
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <CardTitle>Certificate</CardTitle>
            <CardDescription className="truncate">
              {entry.host === "*" ? "any host" : entry.host}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={entry.state === "managed" || entry.state === "wildcard-covered" ? "secondary" : "outline"}>
            {state.label}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">{entry.reason ?? state.detail}</p>
        {entry.coveredBy && (
          <p className="text-sm">
            Covered by <Badge variant="secondary" className="ml-1 font-mono">{entry.coveredBy}</Badge>
          </p>
        )}
        {["managed", "on-demand", "wildcard-covered"].includes(entry.state) && entry.host !== "*" && (
          <TlsLastError host={entry.host} />
        )}
        {entry.issuers.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {entry.issuers.map((issuer, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="font-medium">{issuer.name}</span>
                <span className="text-xs text-muted-foreground">{i === 0 ? "issuer" : "fallback"}</span>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {issuer.challenges.map((c) => (
                    <Badge key={c} variant="outline">
                      {CHALLENGE_LABELS[c]}
                      {c === "dns" && issuer.dnsProvider ? ` · ${issuer.dnsProvider}` : ""}
                    </Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {PROBEABLE.includes(entry.state) && <CertificateProbe host={entry.host} />}
      </CardContent>
    </Card>
  )
}

/** Certificate details for a Host, derived from the running Caddy config. Renders nothing for other nodes. */
export function TlsTab({ name, kind }: { name: string; kind: NodeKind }) {
  const [reply, setReply] = useState<TlsReply | null>(null)

  useEffect(() => {
    let cancelled = false
    api<TlsReply>("/api/tls")
      .then((r) => !cancelled && setReply(r.body))
      .catch((error: Error) => !cancelled && setReply({ ok: false, error: error.message }))
    return () => {
      cancelled = true
    }
  }, [])

  if (kind !== "host") return null
  if (!reply) return <Skeleton className="h-40 w-full rounded-xl" />
  if (!reply.ok) return <p className="text-sm text-destructive">{reply.error}</p>

  const host = name === "any host" ? "*" : name
  const site = reply.sites.find((s) => s.hosts.some((h) => h.host === host))
  if (!site) return <p className="text-sm text-muted-foreground">No TLS information for this host in the running config.</p>

  return (
    <div className="flex h-full flex-col gap-4">
      {site.hosts.map((entry) => (
        <HostBlock key={entry.host} entry={entry} />
      ))}
    </div>
  )
}
