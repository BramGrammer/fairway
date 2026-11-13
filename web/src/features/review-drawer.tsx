import { useRouter } from "@/hooks/use-router"
import { SideDrawer } from "@/components/side-drawer"
import { SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/features/reviews-table"
import {
  evidenceLine,
  findSite,
  logsParams,
  formatTokens,
  groupByLevel,
  linesRequestedLabel,
  LEVEL_LABELS,
  periodLabel,
  reviewFixPrompt,
  SKIP_REASONS,
  stampLabel,
  UNSEEN_REASONS,
  type Observation,
  type Review,
} from "@/lib/reviews"
import type { Site } from "@/lib/api"

/** What a link needs to know: the Sites of the running config, and the time. Null sites means not known yet. */
export interface LinkContext {
  sites: Site[] | null
  now: number
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

/** Everything that comes from the model is text: React escapes it, and it is never read as HTML or Markdown. */
function ObservationCard({ observation, review, links }: { observation: Observation; review: Review; links: LinkContext }) {
  const { linkProps } = useRouter()
  // A Site that is no longer in the running config is shown, but cannot be linked.
  const known = links.sites ? observation.sites.map((host) => ({ host, site: findSite(links.sites ?? [], host) })) : []
  const siteOf = (host: string) => known.find((entry) => entry.host === host)?.site
  const first = known.find((entry) => entry.site)?.site
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-words">{observation.title}</span>
        {observation.ongoing && <Badge variant="secondary">Ongoing</Badge>}
      </div>
      {observation.sites.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {observation.sites.map((host) => {
            const site = siteOf(host)
            return (
              <Badge
                key={host}
                variant="outline"
                className="font-mono"
                render={site ? <a {...linkProps("routes", logsParams(site, review, links.now))} title={`Open the log of ${host}`} /> : undefined}
              >
                {host}
              </Badge>
            )
          })}
        </div>
      )}
      <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{observation.explanation}</p>
      {observation.evidence.length > 0 && (
        <ul className="flex flex-col gap-1 border-t pt-2">
          {observation.evidence.map((item, index) => (
            <li key={index} className="font-mono text-xs break-all">
              {first ? (
                <a className="underline-offset-2 hover:underline" {...linkProps("routes", logsParams(first, review, links.now, item))} title="Open the log with this filter">
                  {evidenceLine(item)}
                </a>
              ) : (
                evidenceLine(item)
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** One Review in a drawer: what it found by level, and what it could not see. */
export function ReviewDrawer({ review, links, onAskAssistant, onClose }: { review: Review; links: LinkContext; onAskAssistant?: (message: string) => void; onClose: () => void }) {
  const fixPrompt = onAskAssistant ? reviewFixPrompt(review) : null
  const groups = groupByLevel(review.observations)
  const unseen = review.coverage.sites.flatMap((site) => site.unseen.map((part) => ({ ...part, site: site.site })))
  const gaps = review.coverage.gaps ?? []
  return (
    <SideDrawer
      label={`Review ${review.id}`}
      onClose={onClose}
      title={
        <>
          <h2 className="text-lg font-semibold tracking-tight">Review</h2>
          <StatusBadge status={review.status} />
        </>
      }
      actions={
        fixPrompt !== null && (
          <Button variant="outline" size="sm" onClick={() => onAskAssistant?.(fixPrompt)}>
            <SparklesIcon data-icon="inline-start" />
            Ask the Assistant to fix
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Started</dt>
          <dd>{new Date(review.startedAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Started by</dt>
          <dd>{review.trigger === "schedule" ? "The schedule" : review.trigger === "retry" ? "A retry after a failed Review" : "Review now"}</dd>
          <dt className="text-muted-foreground">Period</dt>
          <dd>{periodLabel(review.period)}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono break-all">{review.model}</dd>
          <dt className="text-muted-foreground">Tokens</dt>
          <dd>
            {review.usage
              ? `${formatTokens(review.usage.promptTokens)} read, ${formatTokens(review.usage.completionTokens)} written`
              : "Not reported"}
          </dd>
        </dl>

        {review.status === "running" && <p className="text-sm text-muted-foreground">This Review is still running.</p>}

        {review.status === "failed" && (
          <Section title="Why it failed">
            <p className="text-sm whitespace-pre-wrap break-words text-destructive">{review.failure ?? "No reason was recorded."}</p>
          </Section>
        )}

        {review.status === "done" && (
          <>
            <Section title="Summary">
              <p className="text-sm whitespace-pre-wrap break-words">{review.summary}</p>
            </Section>
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing stood out in this period.</p>
            ) : (
              groups.map((group) => (
                <Section
                  key={group.level}
                  title={`${LEVEL_LABELS[group.level]} (${group.observations.length})`}
                >
                  <ul className="flex flex-col gap-2" data-level={group.level} aria-label={`${LEVEL_LABELS[group.level]} observations`}>
                    {group.observations.map((observation, index) => (
                      <ObservationCard key={index} observation={observation} review={review} links={links} />
                    ))}
                  </ul>
                </Section>
              ))
            )}
          </>
        )}

        {(review.linesRequested ?? []).length > 0 && (
          <Section title="Lines looked at">
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {(review.linesRequested ?? []).map((item, index) => (
                <li key={index} className="break-words">
                  {linesRequestedLabel(item)}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(unseen.length > 0 || gaps.length > 0 || review.coverage.skipped.length > 0) && (
          <Section title="What could not be seen">
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {gaps.map((gap, index) => (
                <li key={`g${index}`}>
                  {stampLabel(gap.from)} to {stampLabel(gap.to)}. Fairway ran no Review in this time.
                </li>
              ))}
              {unseen.map((part, index) => (
                <li key={`u${index}`}>
                  <span className="font-mono">{part.site}</span>: {stampLabel(part.from)} to {stampLabel(part.to)}. {UNSEEN_REASONS[part.reason]}.
                </li>
              ))}
              {review.coverage.skipped.map((site, index) => (
                <li key={`s${index}`}>
                  <span className="font-mono">{site.site}</span> was skipped: {SKIP_REASONS[site.reason]}.
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </SideDrawer>
  )
}
