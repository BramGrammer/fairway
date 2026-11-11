import { useCallback, useEffect, useState } from "react"
import {
  ActivityIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FileCodeIcon,
  HistoryIcon,
  MoonIcon,
  RouteIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SunIcon,
  type LucideIcon,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { FairwayLogo } from "@/components/fairway-logo"
import { TopBarSlotProvider } from "@/components/top-bar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { onShowInEditor } from "@/lib/show-in-editor"
import { EditorTab } from "@/features/editor-tab"
import { EventsTab } from "@/features/events-tab"
import { HistoryTab } from "@/features/history-tab"
import { LogsTab } from "@/features/logs-tab"
import { RoutesTab } from "@/features/routes-tab"
import { SettingsDialog } from "@/features/settings-dialog"
import { useCaddyfile } from "@/hooks/use-caddyfile"
import { useIsDark } from "@/hooks/use-is-dark"
import { LoginView } from "@/components/login-form"
import { UserMenu } from "@/components/user-menu"
import { api, onSessionLost, type StatusInfo } from "@/lib/api"
import { LoginRequiredContext } from "@/lib/login-context"
import { decideGate, type AuthStatus, type Gate } from "@/lib/auth"

type View = "editor" | "routes" | "history" | "events" | "logs"

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "editor", label: "Editor", icon: FileCodeIcon },
  { id: "routes", label: "Routes", icon: RouteIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "events", label: "Events", icon: ActivityIcon },
  { id: "logs", label: "Logs", icon: ScrollTextIcon },
]

function initialView(): View {
  const hash = window.location.hash.slice(1)
  return NAV.some((item) => item.id === hash) ? (hash as View) : "editor"
}

function useStatus() {
  const [status, setStatus] = useState<StatusInfo | null>(null)
  useEffect(() => {
    async function refresh() {
      try {
        const reply = await api<StatusInfo>("/api/status", undefined, { background: true })
        if (reply.status === 200) setStatus(reply.body)
      } catch {
        setStatus({ caddyReachable: false, auth: { mode: "none" } })
      }
    }
    void refresh()
    const timer = setInterval(refresh, 15_000)
    return () => clearInterval(timer)
  }, [])
  return status
}

function StatusBadges({ status }: { status: StatusInfo | null }) {
  if (!status) return null
  return (
    <div className="flex flex-col items-start gap-1.5 px-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      {status.auth.mode === "none" && (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="destructive" />}>
            <ShieldAlertIcon data-icon="inline-start" />
            <span className="group-data-[collapsible=icon]:hidden">No authentication</span>
          </TooltipTrigger>
          <TooltipContent side="right">
            No authentication. Anyone who can reach this page can change your proxy. Fairway is meant for an internal network: restrict access at the network layer.
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger render={<Badge variant={status.caddyReachable ? "secondary" : "destructive"} />}>
          {status.caddyReachable ? (
            <CircleCheckIcon data-icon="inline-start" />
          ) : (
            <CircleAlertIcon data-icon="inline-start" />
          )}
          <span className="group-data-[collapsible=icon]:hidden">
            {status.caddyReachable ? "Caddy connected" : "Caddy unreachable"}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          {status.caddyReachable ? "Caddy connected" : "Caddy unreachable"}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function ThemeMenuItem() {
  const { setTheme } = useTheme()
  const dark = useIsDark()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={dark ? "Light mode" : "Dark mode"}
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
        <span>{dark ? "Light mode" : "Dark mode"}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function Editor({ user, onLogout }: { user: string | null; onLogout: () => void }) {
  const [view, setView] = useState<View>(initialView)
  const [topBarSlot, setTopBarSlot] = useState<HTMLElement | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const caddyfile = useCaddyfile()
  const status = useStatus()

  useEffect(() => onShowInEditor(() => setView("editor")), [])

  useEffect(() => {
    window.history.replaceState(null, "", `#${view}`)
  }, [view])

  const current = NAV.find((item) => item.id === view)!

  return (
    <SidebarProvider className="h-svh">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 p-1">
            <FairwayLogo className="size-8 shrink-0 text-primary" />
            <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-heading font-semibold">Fairway</span>
              <span className="truncate text-xs text-muted-foreground">Caddy control</span>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Caddyfile</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={view === item.id}
                      tooltip={item.label}
                      onClick={() => setView(item.id)}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.id === "editor" && caddyfile.dirty && (
                      <SidebarMenuBadge>edited</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <StatusBadges status={status} />
          <SidebarMenu>
            <ThemeMenuItem />
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Settings" onClick={() => setSettingsOpen(true)}>
                <SettingsIcon />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {user !== null && <UserMenu user={user} onLogout={onLogout} />}
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="h-svh min-w-0 overflow-hidden md:h-[calc(100svh-1rem)]">
        <TopBarSlotProvider value={topBarSlot}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <h1 className="font-heading font-medium">{current.label}</h1>
          <div ref={setTopBarSlot} className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto" />
        </header>

        <div hidden={view !== "editor"} className="min-h-0 flex-1">
          {caddyfile.error ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleAlertIcon />
                </EmptyMedia>
                <EmptyTitle>Cannot read the Caddyfile</EmptyTitle>
                <EmptyDescription>Check that the editor can reach the mounted file.</EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => void caddyfile.load()}>
                Try again
              </Button>
            </Empty>
          ) : caddyfile.base === null ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-8 w-80 bg-card" />
              <Skeleton className="h-96 w-full bg-card" />
            </div>
          ) : (
            <EditorTab
              active={view === "editor"}
              text={caddyfile.text}
              onTextChange={caddyfile.setText}
              baseText={caddyfile.base.text}
              baseHash={caddyfile.base.hash}
              onDeployed={caddyfile.deployed}
              onUseDisk={caddyfile.load}
            />
          )}
        </div>

        {view === "routes" && (
          <div className="min-h-0 flex-1">
            <RoutesTab editorText={caddyfile.text} />
          </div>
        )}

        {view === "history" && (
          <div className="min-h-0 flex-1">
            <HistoryTab
              dirty={caddyfile.dirty}
              onLoadIntoEditor={(text) => {
                caddyfile.setText(text)
                setView("editor")
              }}
              onRolledBack={caddyfile.load}
            />
          </div>
        )}

        {view === "events" && (
          <div className="min-h-0 flex-1">
            <EventsTab />
          </div>
        )}

        <div hidden={view !== "logs"} className="min-h-0 flex-1">
          <LogsTab active={view === "logs"} />
        </div>
        </TopBarSlotProvider>
      </SidebarInset>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} user={user} />
    </SidebarProvider>
  )
}

/** Decides between the login view and the editor. The editor remounts after a sign in, so unsaved text is dropped. */
export default function App() {
  const [gate, setGate] = useState<Gate | "loading">("loading")

  const check = useCallback(async () => {
    try {
      const { body } = await api<AuthStatus>("/api/auth/status")
      setGate(decideGate(body))
    } catch {
      // Server unreachable: show the editor, whose own calls report the failure.
      setGate({ view: "editor", user: null })
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void check(), 0)
    const unsubscribe = onSessionLost(() => setGate({ view: "login" }))
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [check])

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", {})
    } finally {
      setGate({ view: "login" })
    }
  }, [])

  if (gate === "loading") return <div className="min-h-svh bg-background" />
  if (gate.view === "login") return <LoginView onSignedIn={() => void check()} />
  return (
    <LoginRequiredContext value={gate.user !== null}>
      <Editor user={gate.user} onLogout={() => void logout()} />
    </LoginRequiredContext>
  )
}
