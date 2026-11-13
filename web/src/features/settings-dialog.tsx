import { useState } from "react"
import type { SettingsCategory } from "@/lib/router"
import { ActivityIcon, BellIcon, SparklesIcon, SettingsIcon, ShieldAlertIcon, ShieldCheckIcon, type LucideIcon } from "lucide-react"

import { AiSettingsPanel } from "@/features/ai-settings-panel"
import { AlertSettingsPanel } from "@/features/alert-settings-panel"
import { GeneralSettings } from "@/features/general-settings"
import { MonitoringSettings } from "@/features/monitoring-settings"
import { ErrorLine } from "@/features/settings-shared"
import { Spinner } from "@/components/ui/spinner"
import { useAlertSettings } from "@/hooks/use-alert-settings"
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

export type { SettingsCategory }

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: LucideIcon; description: string }> = [
  { id: "general", label: "General", icon: SettingsIcon, description: "This Fairway and this browser." },
  { id: "monitoring", label: "Monitoring", icon: ActivityIcon, description: "When Caddy or an upstream counts as down." },
  { id: "alerts", label: "Alerts", icon: BellIcon, description: "Where messages go, and what sends one." },
  { id: "ai", label: "AI", icon: SparklesIcon, description: "The model endpoint the Assistant and Reviews will use." },
  { id: "access", label: "Access", icon: ShieldCheckIcon, description: "Who can use this Fairway." },
]

function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  )
}

/** The panel of one category. The alert settings are loaded once here and shared by General, Monitoring and Alerts. */
function CategoryPanel({ active, user }: { active: SettingsCategory; user: string | null }) {
  const actions = useAlertSettings()
  const { view, loadError, save } = actions

  if (active === "access") return <AccessSettings user={user} />
  if (active === "ai") return <AiSettingsPanel />
  const failed = loadError && !view && (
    <div className="flex flex-col items-start gap-2">
      <ErrorLine message={loadError} />
      <Button variant="outline" size="sm" onClick={() => void actions.reload()}>
        Try again
      </Button>
    </div>
  )
  const waiting = failed || <Loading />
  if (active === "general") return <GeneralSettings view={view} save={save} loading={waiting} />
  if (!view) return waiting
  if (active === "monitoring") return <MonitoringSettings view={view} save={save} />
  return <AlertSettingsPanel view={view} actions={actions} />
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
  category,
  onCategoryChange,
  onClose,
  user,
}: {
  /** The open category, or null while the dialog is closed. */
  category: SettingsCategory | null
  onCategoryChange: (category: SettingsCategory) => void
  onClose: () => void
  /** The signed-in Owner, or null when Fairway runs without a login. */
  user: string | null
}) {
  // The last open category stays on screen while the dialog fades out.
  const [shown, setShown] = useState<SettingsCategory>(category ?? "general")
  if (category !== null && category !== shown) setShown(category)
  const active = shown
  const setActive = onCategoryChange
  const current = CATEGORIES.find((category) => category.id === active)!

  return (
    <Dialog open={category !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[85vh] max-h-[640px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">General, monitoring, alerts and access of this Fairway.</DialogDescription>

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

                <CategoryPanel active={active} user={user} />
              </div>
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
