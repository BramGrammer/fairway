import { ShieldAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { TlsBadge as Badge } from "@/lib/tls-badges"

/** Amber or red marker for a Certificate that needs attention. Callers pass null for healthy Sites. */
export function TlsBadge({ badge, className }: { badge: Badge | null; className?: string }) {
  if (!badge) return null
  return (
    <span
      role="img"
      aria-label={badge.severity === "red" ? "Certificate problem" : "Certificate needs attention"}
      title={badge.title}
      className={cn("shrink-0", badge.severity === "red" ? "text-destructive" : "text-amber-600 dark:text-amber-400", className)}
    >
      <ShieldAlertIcon className="size-3.5" />
    </span>
  )
}
