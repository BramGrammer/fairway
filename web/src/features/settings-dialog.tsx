import { useEffect, useState } from "react"
import {
  BellIcon,
  BellOffIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SunIcon,
  type LucideIcon,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAlertTest } from "@/hooks/use-alert-test"
import { api } from "@/lib/api"
import { PRESSED } from "@/lib/toggle-styles"
import { cn } from "@/lib/utils"

export type SettingsCategory = "appearance" | "alerts" | "access"

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: LucideIcon; description: string }> = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon, description: "How Fairway looks in this browser." },
  { id: "alerts", label: "Alerts", icon: BellIcon, description: "Push messages when something turns bad." },
  { id: "access", label: "Access", icon: ShieldCheckIcon, description: "Who can use this Fairway." },
]

const THEMES = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  return (
    <FieldSet>
      <FieldLegend>Theme</FieldLegend>
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
    </FieldSet>
  )
}

function AlertSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const { testing, result, send } = useAlertTest()

  useEffect(() => {
    let stopped = false
    api<{ ok: boolean; enabled: boolean }>("/api/alerts", undefined, { background: true })
      .then(({ body }) => {
        if (!stopped) setEnabled(body.enabled)
      })
      .catch(() => {
        if (!stopped) setFailed(true)
      })
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <FieldSet>
        <FieldLegend>Push messages</FieldLegend>
        <FieldGroup>
          <div className="flex items-start gap-3 rounded-lg border p-3">
            {enabled ? (
              <BellIcon className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <BellOffIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium">
                {failed ? "Cannot reach the editor server" : enabled === null ? "Checking…" : enabled ? "Alerts are on" : "Alerts are off"}
              </span>
              <span className="text-sm text-muted-foreground">
                {enabled === false ? (
                  <>
                    Set <code className="font-mono text-xs">NTFY_URL</code> in the environment and restart Fairway. The history is kept either way.
                  </>
                ) : (
                  "Fairway sends a message through ntfy when a Certificate turns amber or red, an upstream or Caddy goes down or recovers, a Deploy is refused, or the Caddyfile is changed outside Fairway."
                )}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={send} disabled={testing || !enabled}>
              {testing ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
              Send test
            </Button>
          </div>
          {result && (
            <p role="status" className={cn("text-xs", result.ok ? "text-success" : "text-destructive")}>
              {result.ok ? "Test alert sent." : `Test failed: ${result.error}`}
            </p>
          )}
          <FieldDescription>
            The topic address and token come from the environment and are never shown here.
          </FieldDescription>
        </FieldGroup>
      </FieldSet>
    </div>
  )
}

function AccessSettings({ user }: { user: string | null }) {
  return (
    <FieldSet>
      <FieldLegend>Sign in</FieldLegend>
      <FieldGroup>
        <div className="flex items-start gap-3 rounded-lg border p-3">
          {user !== null ? (
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">
              {user !== null ? (
                <>
                  Login is on, signed in as <span className="font-mono">{user}</span>
                </>
              ) : (
                "No authentication"
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {user !== null ? (
                "Sessions last 12 hours since the last activity and at most 7 days."
              ) : (
                <>
                  Anyone who can reach this page can change your proxy. Set <code className="font-mono text-xs">AUTH_USER</code> and a password in the environment.
                </>
              )}
            </span>
          </div>
        </div>
      </FieldGroup>
    </FieldSet>
  )
}

/** Settings in a dialog with a nested sidebar of categories. */
export function SettingsDialog({
  open,
  onOpenChange,
  user,
  initial = "appearance",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The signed-in Owner, or null when Fairway runs without a login. */
  user: string | null
  initial?: SettingsCategory
}) {
  const [active, setActive] = useState<SettingsCategory>(initial)
  const current = CATEGORIES.find((category) => category.id === active)!

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-h-[640px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Appearance, alerts and access of this Fairway.</DialogDescription>

        <SidebarProvider className="min-h-0 flex-1 items-stretch">
          <Sidebar collapsible="none" className="hidden w-48 shrink-0 border-r md:flex">
            <SidebarContent className="p-2 pt-4">
              <SidebarGroup className="p-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {CATEGORIES.map((category) => (
                      <SidebarMenuItem key={category.id}>
                        <SidebarMenuButton isActive={active === category.id} onClick={() => setActive(category.id)}>
                          <category.icon />
                          <span>{category.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-6 p-6 pr-12">
                <Breadcrumb>
                  <BreadcrumbList className="text-xs">
                    <BreadcrumbItem>Settings</BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{current.label}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                {/* On a narrow screen the sidebar is hidden, so the categories become a row of buttons. */}
                <div className="flex gap-1 md:hidden" role="tablist" aria-label="Settings categories">
                  {CATEGORIES.map((category) => (
                    <Button
                      key={category.id}
                      role="tab"
                      aria-selected={active === category.id}
                      variant={active === category.id ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setActive(category.id)}
                    >
                      <category.icon data-icon="inline-start" />
                      {category.label}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-col gap-1">
                  <h2 className="font-heading text-base font-semibold">{current.label}</h2>
                  <FieldDescription>{current.description}</FieldDescription>
                </div>

                {active === "appearance" && <AppearanceSettings />}
                {active === "alerts" && <AlertSettings />}
                {active === "access" && <AccessSettings user={user} />}
              </div>
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
