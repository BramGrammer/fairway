import { FileCodeIcon, ServerIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

const plural = (count: number, word: string) => `${word}${count === 1 ? "" : "s"}`

/** What the Routes page is showing: how many of each thing, and where it comes from. */
export function RoutesSummary({
  sites,
  routes,
  upstreams,
  source,
}: {
  sites: number
  routes: number
  upstreams: number
  source: "running" | "editor"
}) {
  const counts = [
    [sites, "site"],
    [routes, "route"],
    [upstreams, "upstream"],
  ] as const
  return (
    <div className="flex flex-wrap items-center gap-2">
      {counts.map(([count, word]) => (
        <Badge key={word} variant="outline" className="gap-1 font-normal text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{count}</span>
          {plural(count, word)}
        </Badge>
      ))}
      <Badge variant="secondary">
        {source === "running" ? <ServerIcon data-icon="inline-start" /> : <FileCodeIcon data-icon="inline-start" />}
        {source === "running" ? "Running config" : "Unsaved editor text"}
      </Badge>
    </div>
  )
}
