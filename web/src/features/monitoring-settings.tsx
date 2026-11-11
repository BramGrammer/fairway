import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { TimingRow, type Save } from "@/features/settings-shared"
import { TIMING_FIELDS, type AlertSettingsView } from "@/lib/alert-settings"

/** The Monitoring category: how long a problem must last before it counts as down. */
export function MonitoringSettings({ view, save }: { view: AlertSettingsView; save: Save }) {
  return (
    <FieldSet>
      <FieldLegend>How long a problem must last</FieldLegend>
      <FieldGroup>
        <div className="flex flex-col divide-y rounded-lg border">
          {TIMING_FIELDS.filter((f) => f.key === "caddyHoldSec" || f.key === "upstreamHoldSec").map((field) => (
            <TimingRow key={`${field.key}:${view.timing[field.key].value}`} field={field} view={view.timing[field.key]} save={save} />
          ))}
        </div>
        <FieldDescription>A shorter blip never shows in the history or sends an Alert.</FieldDescription>
      </FieldGroup>
    </FieldSet>
  )
}
