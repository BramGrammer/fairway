import type { ReactNode } from "react"
import {
  ArrowRightIcon,
  CircleQuestionMarkIcon,
  CornerDownRightIcon,
  FolderIcon,
  GlobeIcon,
  LayersIcon,
  MessageSquareIcon,
  RouteIcon,
  ServerIcon,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableHeader, TableHead, TableCell, TableRow } from "@/components/ui/table"
import { FlowStrip, type FlowItem } from "@/features/flow-strip"
import { LinkActions } from "@/features/route-links-view"
import { describeNode, destLabel, type OverviewData } from "@/features/route-overview"
import { HealthStatus } from "@/features/health-dot"
import type { Chip, Destination } from "@/lib/api"
import { hostLinks, ruleLinks, upstreamLink } from "@/lib/route-links"
import { upstreamHealth, type UpstreamsReply } from "@/lib/upstream-health"

const DEST_ICONS: Record<string, LucideIcon> = {
  proxy: ArrowRightIcon,
  file: FolderIcon,
  redirect: CornerDownRightIcon,
  respond: MessageSquareIcon,
  other: CircleQuestionMarkIcon,
}

/** A drawer card: icon tile, title and description in the header, an optional action on the right. */
function Panel({
  icon: Icon,
  title,
  description,
  action,
  mono,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  mono?: boolean
  children?: ReactNode
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <CardTitle className={mono ? "truncate font-mono" : "truncate"}>{title}</CardTitle>
            {description && <CardDescription className="truncate">{description}</CardDescription>}
          </div>
        </div>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {children && <CardContent className="flex flex-col gap-3">{children}</CardContent>}
    </Card>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[13px]">{children}</span>

/** A label with its value, for facts like the ports a Site listens on. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 truncate text-right font-medium">{children}</span>
  </div>
)

/** The rule's path pattern; a rule without one takes all requests, or the leftovers when the Site has other rules. */
const matchText = (match: string, siblings: number) => match || (siblings > 0 ? "Everything else" : "All requests")

/** Patterns read as code; the catch-all wording reads as plain text. */
const MatchLabel = ({ match, siblings }: { match: string; siblings: number }) =>
  match ? <Mono>{match}</Mono> : <span className="text-sm font-medium">{matchText(match, siblings)}</span>

/** Middleware as rows so details such as allowed countries stay readable. */
function MiddlewareList({ chips, scope }: { chips: Chip[]; scope?: "Site-wide" | "Rule" }) {
  if (chips.length === 0) return null
  return (
    <ul className="flex flex-col gap-2">
      {chips.map((chip) => (
        <li
          key={`${chip.label}|${chip.detail ?? ""}`}
          className="flex items-start gap-3 rounded-lg bg-muted/60 px-3 py-2"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{chip.label}</span>
            {chip.detail && <span className="break-words font-mono text-xs text-muted-foreground">{chip.detail}</span>}
          </div>
          {scope && (
            <Badge variant={scope === "Site-wide" ? "secondary" : "outline"} className="shrink-0">
              {scope}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  )
}

/** One item per upstream for a proxy, so each can be opened and copied on its own. */
const expand = (dest: Destination) =>
  dest.kind === "proxy" && dest.upstreams?.length
    ? dest.upstreams.map((upstream) => ({ label: upstream, dest }))
    : [{ label: destLabel(dest), dest }]

const healthOf = (item: { label: string; dest: Destination }, health: UpstreamsReply | null | undefined) =>
  item.dest.kind === "proxy" ? upstreamHealth(item.label, health ?? null) : null

/** Destinations as compact lines for a table cell: kind icon, target, health and Open/Copy. */
function DestLines({ items, health }: { items: { label: string; dest: Destination }[]; health?: UpstreamsReply | null }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, i) => {
        const link = item.dest.kind === "proxy" ? upstreamLink(item.label) : null
        const Icon = DEST_ICONS[item.dest.kind] ?? CircleQuestionMarkIcon
        return (
          <li key={`${item.label}|${i}`} className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-mono text-[13px]">{item.label}</span>
            <HealthStatus state={healthOf(item, health)} />
            {link && <LinkActions links={[link]} labelled={false} />}
          </li>
        )
      })}
    </ul>
  )
}

/** Middleware as inline badges with their details alongside; empty renders a dash. */
function MiddlewareBadges({ chips }: { chips: { chip: Chip; scope?: "Site-wide" | "Rule" }[] }) {
  if (chips.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <ul className="flex flex-col gap-1">
      {chips.map(({ chip, scope }) => (
        <li key={`${chip.label}|${chip.detail ?? ""}|${scope ?? ""}`} className="flex flex-wrap items-center gap-x-2">
          <Badge variant={scope === "Rule" ? "outline" : "secondary"}>{chip.label}</Badge>
          {chip.detail && <span className="font-mono text-xs text-muted-foreground">{chip.detail}</span>}
        </li>
      ))}
    </ul>
  )
}

const asChips = (chips: Chip[], scope?: "Site-wide" | "Rule") => chips.map((chip) => ({ chip, scope }))

/** A card holding a full-bleed table. */
function TablePanel({
  icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="col-span-full [&>*]:h-auto">
      <Panel icon={icon} title={title} description={description}>
        <div className="-mx-4 -mb-1 border-t">{children}</div>
      </Panel>
    </div>
  )
}

const Th = ({ children, className }: { children: ReactNode; className?: string }) => (
  <TableHead className={`h-9 px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground ${className ?? ""}`}>
    {children}
  </TableHead>
)
const Td = ({ children, className }: { children: ReactNode; className?: string }) => (
  <TableCell className={`px-4 py-3 align-top whitespace-normal ${className ?? ""}`}>{children}</TableCell>
)

interface RouteOverviewProps {
  data: OverviewData
  id: string
  /** Opens another node's drawer view. */
  onOpen: (id: string) => void
  /** Caddy's upstream health; absent or unreadable means no status is shown. */
  health?: UpstreamsReply | null
  /** Requests per second through the node; sets how fast the flow animates. Null when metrics are unavailable. */
  rate?: number | null
  /** Live traffic for the node, shown right under the flow. */
  traffic?: ReactNode
  /** The Certificate, for host nodes. */
  tls?: ReactNode
}

const destTitle = (dest: Destination) => destLabel(dest)
const hostsTitle = (hosts: string[]) => (hosts.length > 1 ? `${hosts[0]} +${hosts.length - 1}` : (hosts[0] ?? "any host"))
const chipsTitle = (chips: Chip[]) => (chips.length ? chips.map((c) => c.label).join(" · ") : "No middleware")

function dedupe(items: FlowItem[]): FlowItem[] {
  const seen = new Set<string>()
  return items.filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true)))
}

const Cards = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-4">{children}</div>
)

/** Traffic and, for hosts, the Certificate, one below the other. */
const Insights = ({ traffic, tls }: { traffic?: ReactNode; tls?: ReactNode }) => (
  <div className="flex flex-col gap-4">
    {traffic}
    {tls}
  </div>
)

const shareText = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`

export function RouteOverview({ data, id, onOpen, health, rate = null, traffic, tls }: RouteOverviewProps) {
  const view = describeNode(data, id)
  if (!view) return <p className="text-sm text-muted-foreground">This node is no longer in the configuration.</p>

  return (
    <div className="flex flex-col gap-5 pt-5 pb-3">
      {view.kind === "site" && (
        <>
          <FlowStrip
            key={id}
            rate={rate}
            current={{
              eyebrow: view.hosts.length > 1 ? `Hosts · ${view.hosts.length}` : "Host",
              title: hostsTitle(view.hosts),
              sub: view.listen.join(", ") || "default ports",
              mono: true,
            }}
            afterNoun={["rule", "rules"]}
            after={view.rules.map((rule, i) => ({
              key: `${rule.match}|${i}`,
              title: matchText(rule.match, view.rules.length - 1),
              sub: rule.destinations.map(destTitle).join(", "),
              mono: true,
            }))}
          />
          <Insights traffic={traffic} tls={tls} />
          <Cards>
            <Panel
              icon={GlobeIcon}
              title={view.hosts.length > 1 ? `${view.hosts.length} hosts` : "Host"}
              description="Names this Site answers to"
            >
              <div className="flex flex-wrap gap-1.5">
                {view.hosts.map((host) => (
                  <Badge key={host} variant="secondary" className="h-6 px-2 font-mono text-[13px]">
                    {host}
                  </Badge>
                ))}
              </div>
              <Separator />
              <Fact label="Listens on">
                <Mono>{view.listen.join(", ") || "default ports"}</Mono>
              </Fact>
              <LinkActions links={hostLinks(view)} />
            </Panel>
            {view.middleware.length > 0 && (
              <Panel icon={LayersIcon} title="Site-wide middleware" description="Applies to every rule on this Site">
                <MiddlewareList chips={view.middleware} />
              </Panel>
            )}
            <TablePanel
              icon={RouteIcon}
              title={view.rules.length === 1 ? "Rule" : `${view.rules.length} rules`}
              description="Requests are matched top to bottom"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <Th className="w-[40%]">Matches</Th>
                    <Th>Goes to</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rules.map((rule, i) => (
                    <TableRow key={`${rule.match}|${i}`}>
                      <Td>
                        <div className="flex flex-col gap-2">
                          <MatchLabel match={rule.match} siblings={view.rules.length - 1} />
                          {rule.middleware.length > 0 && <MiddlewareBadges chips={asChips(rule.middleware)} />}
                        </div>
                      </Td>
                      <Td>
                        <DestLines health={health} items={rule.destinations.flatMap(expand)} />
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          </Cards>
        </>
      )}

      {view.kind === "rule" && (
        <>
          <FlowStrip
            key={id}
            rate={rate}
            current={{
              eyebrow: "Middleware stack",
              title: chipsTitle(view.middleware),
              sub: `used by ${view.instances.length} ${view.instances.length === 1 ? "rule" : "rules"}`,
            }}
            beforeNoun={["rule", "rules"]}
            afterNoun={["destination", "destinations"]}
            before={view.instances.map((instance, i) => ({
              key: `${instance.hosts.join(",")}|${instance.match}|${i}`,
              title: hostsTitle(instance.hosts),
              sub: matchText(instance.match, instance.siblings),
              mono: true,
            }))}
            after={dedupe(
              view.instances.flatMap((instance) =>
                instance.destinations.map((d) => ({ key: d.id, title: d.label, sub: d.dest.kind, mono: true })),
              ),
            )}
          />
          <Insights traffic={traffic} tls={tls} />
          <Cards>
            <TablePanel
              icon={RouteIcon}
              title="Used by"
              description={`${view.instances.length} ${view.instances.length === 1 ? "rule" : "rules"} share this middleware stack`}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <Th className="w-[45%]">Rule</Th>
                    <Th>Goes to</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.instances.map((instance, i) => (
                    <TableRow key={`${instance.hosts.join(",")}|${instance.match}|${i}`}>
                      <Td>
                        <div className="flex flex-col gap-2">
                          <Mono>{instance.hosts.join(", ")}</Mono>
                          <MatchLabel match={instance.match} siblings={instance.siblings} />
                          <MiddlewareBadges
                            chips={[...asChips(instance.inherited, "Site-wide"), ...asChips(instance.own, "Rule")]}
                          />
                          <LinkActions links={ruleLinks(instance, instance.match)} />
                        </div>
                      </Td>
                      <Td>
                        <DestLines health={health} items={instance.destinations.flatMap((d) => expand(d.dest))} />
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          </Cards>
        </>
      )}

      {view.kind === "destination" && (
        <>
          <FlowStrip
            key={id}
            rate={rate}
            current={{
              eyebrow: `Destination · ${view.dest.kind}`,
              title: destLabel(view.dest),
              sub: view.share === null ? undefined : `${shareText(view.share)} of traffic`,
              mono: true,
            }}
            beforeNoun={["rule", "rules"]}
            before={view.sources.map((source, i) => ({
              key: `${source.hosts.join(",")}|${source.match}|${i}`,
              title: hostsTitle(source.hosts),
              sub: matchText(source.match, source.siblings),
              mono: true,
            }))}
          />
          <Insights traffic={traffic} tls={tls} />
          <Cards>
            <Panel
              icon={DEST_ICONS[view.dest.kind] ?? ServerIcon}
              title={destLabel(view.dest)}
              mono
              description={`${view.dest.kind[0].toUpperCase()}${view.dest.kind.slice(1)} destination`}
              action={<HealthStatus state={healthOf({ label: destLabel(view.dest), dest: view.dest }, health)} />}
            >
              {view.dest.kind === "proxy" && (
                <LinkActions links={(view.dest.upstreams ?? []).flatMap((u) => upstreamLink(u) ?? [])} />
              )}
            </Panel>
            <Panel icon={ServerIcon} title="Share of traffic" description="Of everything shown in the graph">
              {view.share === null ? (
                <p className="text-sm text-muted-foreground">Available once Caddy reports live traffic.</p>
              ) : (
                <>
                  <p className="text-4xl font-semibold tabular-nums tracking-tight">{shareText(view.share)}</p>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${view.share * 100}%` }} />
                  </div>
                </>
              )}
            </Panel>
            <TablePanel
              icon={RouteIcon}
              title="Receives traffic from"
              description={`${view.sources.length} ${view.sources.length === 1 ? "rule" : "rules"}`}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <Th className="w-1/2">Host</Th>
                    <Th>Matches</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.sources.map((source, i) => (
                    <TableRow key={`${source.hosts.join(",")}|${source.match}|${i}`}>
                      <Td>
                        <Mono>{source.hosts.join(", ")}</Mono>
                      </Td>
                      <Td>
                        <MatchLabel match={source.match} siblings={source.siblings} />
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          </Cards>
        </>
      )}

      {view.kind === "group" && (
        <TablePanel icon={LayersIcon} title={view.label} description={`${view.members.length} members · select one to open it`}>
          <Table>
            <TableHeader>
              <TableRow>
                <Th className="w-1/2">Name</Th>
                <Th>Detail</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.members.map((member) => (
                <TableRow key={member.id} className="cursor-pointer" onClick={() => onOpen(member.id)}>
                  <Td>
                    <Mono>{member.label}</Mono>
                  </Td>
                  <Td className="text-muted-foreground">{member.sub ?? "—"}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      )}
    </div>
  )
}
