import { useState } from "react"
import { BellIcon, BellOffIcon, BellRingIcon, ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useHostAlerts } from "@/hooks/use-host-alerts"
import type { HostAlertPatch } from "@/lib/alert-settings"
import {
  bellState,
  describeBell,
  describeSnooze,
  HOST_KINDS,
  isSnoozed,
  SNOOZE_OPTIONS,
} from "@/lib/host-alerts"
import { cn } from "@/lib/utils"

/** Display only: whether this host sends Alerts right now. */
export function HostAlertBell({ host }: { host: string }) {
  const { hostAlerts } = useHostAlerts()
  const alerts = hostAlerts(host)
  const state = bellState(alerts)
  const Icon = state === "on" ? BellRingIcon : state === "snoozed" ? BellIcon : BellOffIcon
  const label = describeBell(alerts)
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" />}
        aria-label={label}
        className={cn("inline-flex", state === "on" ? "text-success" : "text-muted-foreground", state === "off" && "opacity-50")}
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The Alerts block of the route drawer for one real host name. */
export function HostAlertsBlock({ host }: { host: string }) {
  const { hostAlerts, canAlert, update } = useHostAlerts()
  const [error, setError] = useState<string | null>(null)
  const alerts = hostAlerts(host)
  const snoozed = isSnoozed(alerts)

  const save = async (patch: HostAlertPatch) => {
    const outcome = await update(host, patch)
    setError(outcome.ok ? null : outcome.error)
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Alerts</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch size="sm" checked={alerts.enabled} onCheckedChange={(enabled) => save({ enabled })} />
          Alerts for this host
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" disabled={!alerts.enabled} aria-label="Choose what sends an Alert" />}
          >
            What and when
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {HOST_KINDS.map((kind) => (
              <DropdownMenuCheckboxItem
                key={kind.key}
                checked={alerts.kinds[kind.key]}
                onCheckedChange={(value) => save({ kinds: { [kind.key]: value } })}
                closeOnClick={false}
              >
                <span className="flex flex-col">
                  {kind.label}
                  <span className="text-xs text-muted-foreground">{kind.description}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            {SNOOZE_OPTIONS.map((option) => (
              <DropdownMenuItem key={option.minutes} onClick={() => save({ snoozeMinutes: option.minutes })}>
                {option.label}
              </DropdownMenuItem>
            ))}
            {snoozed && <DropdownMenuItem onClick={() => save({ snoozeMinutes: null })}>End snooze</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        {alerts.enabled && snoozed && alerts.snoozedUntil !== null && (
          <Badge variant="secondary">{describeSnooze(alerts.snoozedUntil)}</Badge>
        )}
      </div>
      {canAlert === false && (
        <p className="text-xs text-muted-foreground">
          No ntfy topic yet, so nothing is sent. Add one under Settings › Alerts.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
