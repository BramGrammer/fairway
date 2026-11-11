import { useRef, useState } from "react"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ErrorLine, ResetButton, type Save } from "@/features/settings-shared"
import { describePublicUrl, publicUrlBody, type AlertSettingsView } from "@/lib/alert-settings"
import { PRESSED } from "@/lib/toggle-styles"

const THEMES = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const

function PublicAddress({ view, save }: { view: AlertSettingsView["publicUrl"]; save: Save }) {
  // Remounted by its key when the saved value changes, so the draft always starts from the server's.
  const [text, setText] = useState(view.value ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lastSent = useRef(view.value ?? "")

  const commit = async () => {
    if (text.trim() === lastSent.current) return
    lastSent.current = text.trim()
    setBusy(true)
    const outcome = await save(publicUrlBody(text))
    setBusy(false)
    if (!outcome.ok) {
      lastSent.current = view.value ?? ""
      setError(outcome.error)
    } else setError(null)
  }
  const reset = async () => {
    setBusy(true)
    const outcome = await save(publicUrlBody(null))
    setBusy(false)
    setError(outcome.ok ? null : outcome.error)
  }

  return (
    <FieldGroup className="gap-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Public address"
          type="url"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
          placeholder="https://fairway.example.test"
          className="max-w-sm font-mono"
        />
        <Button variant="outline" size="sm" onClick={commit} disabled={busy || text.trim() === (view.value ?? "")}>
          Save
        </Button>
        {view.overridden && <ResetButton onClick={reset} disabled={busy} />}
      </div>
      <ErrorLine message={error} />
      <FieldDescription>
        Used for the link in an alert message, so tapping it opens this Fairway. Leave empty for no link.
        {view.envDefault ? ` ${describePublicUrl(view)}` : ""}
      </FieldDescription>
    </FieldGroup>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <FieldGroup>
      <ToggleGroup
        variant="outline"
        spacing={0}
        aria-label="Theme"
        value={[theme]}
        onValueChange={(value) => value[0] && setTheme(value[0] as (typeof THEMES)[number]["value"])}
      >
        {THEMES.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value} className={PRESSED}>
            <item.icon data-icon="inline-start" />
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>System follows your operating system and switches with it. Stored in this browser only.</FieldDescription>
    </FieldGroup>
  )
}

/** The General category: this instance (public address) and this browser (theme). */
export function GeneralSettings({ view, save, loading }: { view: AlertSettingsView | null; save: Save; loading: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <FieldSet>
        <FieldLegend>This instance</FieldLegend>
        {view ? <PublicAddress key={view.publicUrl.value ?? ""} view={view.publicUrl} save={save} /> : loading}
      </FieldSet>
      <FieldSet>
        <FieldLegend>This browser</FieldLegend>
        <ThemeToggle />
      </FieldSet>
    </div>
  )
}
