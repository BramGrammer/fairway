import { useCallback, useEffect, useState } from "react"

import { RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type Severity = "ok" | "amber" | "red"

interface CertInfo {
  issuer: string
  subject: string
  names: string[]
  notBefore: string
  notAfter: string
}

interface HostProbe {
  result: { ok: true; cert: CertInfo } | { ok: false; error: string }
  assessment: { severity: Severity; reasons: string[]; daysLeft?: number }
  checkedAt: string
  cached: boolean
}

type ProbeReply =
  | { ok: true; enabled: false }
  | { ok: true; enabled: true; skipped: string }
  | { ok: true; enabled: true; probe: HostProbe }
  | { ok: false; error: string }

const SEVERITY: Record<Severity, { label: string; badge: string; bar: string; text: string }> = {
  ok: { label: "Healthy", badge: "border-success/40 bg-success/15 text-success", bar: "bg-success", text: "text-success" },
  amber: {
    label: "Attention",
    badge: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-400",
    bar: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  red: { label: "Problem", badge: "border-destructive/50 bg-destructive/15 text-destructive", bar: "bg-destructive", text: "text-destructive" },
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
const DAY_MS = 86_400_000
/** Caddy starts renewing about this many days before a Certificate expires. */
const RENEW_DAYS = 30

/** How much of the Certificate's lifetime is left, with the point where Caddy renews marked on the bar. */
function ExpiryGauge({ cert, daysLeft, severity }: { cert: CertInfo; daysLeft: number; severity: Severity }) {
  const lifetime = Math.max(1, Math.round((Date.parse(cert.notAfter) - Date.parse(cert.notBefore)) / DAY_MS))
  const left = Math.max(0, Math.min(daysLeft, lifetime))
  const renewAt = Math.min(100, (RENEW_DAYS / lifetime) * 100)
  const tone = SEVERITY[severity]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-4xl font-semibold tabular-nums tracking-tight", tone.text)}>
          {daysLeft < 0 ? "Expired" : daysLeft}
        </span>
        {daysLeft >= 0 && <span className="text-sm text-muted-foreground">{daysLeft === 1 ? "day left" : "days left"}</span>}
        <span className="ml-auto text-sm text-muted-foreground">Expires {formatDate(cert.notAfter)}</span>
      </div>
      <div className="relative pb-5">
        <div className="h-2.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-[width] duration-700", tone.bar)}
            style={{ width: `${(left / lifetime) * 100}%` }}
          />
        </div>
        <div className="absolute top-0 flex flex-col items-center" style={{ left: `${renewAt}%` }}>
          <span className="h-2.5 w-px bg-foreground/60" />
          <span className="mt-1 -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground">renews here</span>
        </div>
      </div>
    </div>
  )
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 text-sm">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 text-right font-medium">{children}</span>
  </div>
)

/** The Certificate Caddy actually serves for a host, read by probing `TLS_PROBE_ADDR`. */
export function CertificateProbe({ host }: { host: string }) {
  const [loaded, setReply] = useState<{ host: string; reply: ProbeReply } | null>(null)
  const reply = loaded?.host === host ? loaded.reply : null
  const [busy, setBusy] = useState(false)

  const request = useCallback(
    (force: boolean) =>
      api<ProbeReply>(`/api/tls/probe?host=${encodeURIComponent(host)}${force ? "&force=1" : ""}`).then(
        (r) => ({ host, reply: r.body }),
        (error: Error) => ({ host, reply: { ok: false, error: error.message } as ProbeReply }),
      ),
    [host]
  )

  const recheck = () => {
    setBusy(true)
    void request(true).then((next) => {
      setReply(next)
      setBusy(false)
    })
  }

  useEffect(() => {
    let current = true
    void request(false).then((next) => {
      if (current) setReply(next)
    })
    return () => {
      current = false
    }
  }, [request])

  if (!reply) return <Skeleton className="h-12 w-full" />
  if (!reply.ok) return <p className="text-xs text-destructive">{reply.error}</p>
  if (!reply.enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        To see the served Certificate (issuer and expiry), set <code className="font-mono">TLS_PROBE_ADDR</code> to
        Caddy&apos;s HTTPS address as the editor reaches it, for example <code className="font-mono">192.0.2.10:443</code>.
      </p>
    )
  }
  if ("skipped" in reply) return <p className="text-xs text-muted-foreground">{reply.skipped}</p>

  const { probe } = reply
  const severity = SEVERITY[probe.assessment.severity]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Served Certificate</span>
        <Badge variant="outline" className={severity.badge}>
          {severity.label}
        </Badge>
        <Button size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={recheck}>
          <RefreshCwIcon data-icon="inline-start" className={busy ? "animate-spin" : undefined} />
          {busy ? "Checking…" : "Re-check"}
        </Button>
      </div>
      {probe.result.ok && probe.assessment.daysLeft !== undefined && (
        <ExpiryGauge cert={probe.result.cert} daysLeft={probe.assessment.daysLeft} severity={probe.assessment.severity} />
      )}
      {probe.result.ok && (
        <div className="flex flex-col gap-1.5">
          <Row label="Issuer">{probe.result.cert.issuer}</Row>
          <Row label="Names">
            <span className="flex flex-wrap justify-end gap-1.5">
              {probe.result.cert.names.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono">
                  {name}
                </Badge>
              ))}
            </span>
          </Row>
        </div>
      )}
      {probe.assessment.reasons.map((reason) => (
        <p
          key={reason}
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            probe.assessment.severity === "red" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10",
          )}
        >
          {reason}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">
        Checked {new Date(probe.checkedAt).toLocaleTimeString()}
        {probe.cached ? " · cached for up to 10 minutes" : ""}
      </p>
    </div>
  )
}
