import {
  DatabaseIcon,
  GaugeIcon,
  GlobeIcon,
  KeyRoundIcon,
  PackageIcon,
  PuzzleIcon,
  ReplaceIcon,
  RulerIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TagsIcon,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { Chip } from "@/lib/api"
import { describeStep, fitBadges } from "@/lib/middleware-node"

const ICONS: [RegExp, LucideIcon][] = [
  [/^geo/i, GlobeIcon],
  [/^compression/i, PackageIcon],
  [/^headers/i, TagsIcon],
  [/^cache/i, DatabaseIcon],
  [/^rate limit/i, GaugeIcon],
  [/^waf/i, ShieldIcon],
  [/^auth/i, KeyRoundIcon],
  [/^rewrite/i, ReplaceIcon],
  [/^body limit/i, RulerIcon],
  [/^restricted/i, ShieldCheckIcon],
]

/** The inside of a middleware node: an icon and title, then its values as badges that never spill out of the box. */
export function StepNode({ chip, available, meta }: { chip: Chip; available: number; meta?: string }) {
  const info = describeStep(chip)
  const Icon = ICONS.find(([pattern]) => pattern.test(info.title))?.[1] ?? PuzzleIcon
  const { shown, hidden } = fitBadges(info.items, available)
  return (
    <div className="flex min-w-0 flex-col gap-1.5" title={chip.detail ?? chip.label}>
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[13px] leading-none font-semibold">{info.title}</span>
        {meta && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>}
      </div>
      {info.items.length > 0 && (
        <div className="flex gap-1 overflow-hidden whitespace-nowrap">
          {shown.map((item) => (
            <Badge key={item} variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-medium">
              {item}
            </Badge>
          ))}
          {hidden > 0 && (
            <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] font-medium">
              +{hidden}
            </Badge>
          )}
        </div>
      )}
      {info.note && <span className="truncate text-xs text-muted-foreground">{info.note}</span>}
    </div>
  )
}
