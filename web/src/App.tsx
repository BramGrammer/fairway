import { useEffect, useState } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  FileCodeIcon,
  HistoryIcon,
  MoonIcon,
  RouteIcon,
  ScrollTextIcon,
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
import { EditorTab } from "@/features/editor-tab"
import { HistoryTab } from "@/features/history-tab"
import { LogsTab } from "@/features/logs-tab"
import { RoutesTab } from "@/features/routes-tab"
import { useCaddyfile } from "@/hooks/use-caddyfile"
import { useIsDark } from "@/hooks/use-is-dark"
import { api, type StatusInfo } from "@/lib/api"

type View = "editor" | "routes" | "history" | "logs"

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "editor", label: "Editor", icon: FileCodeIcon },
  { id: "routes", label: "Routes", icon: RouteIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "logs", label: "Logs", icon: ScrollTextIcon },
]

function initialView(): View {
  const hash = window.location.hash.slice(1)
  return NAV.some((item) => item.id === hash) ? (hash as View) : "editor"
}

function useStatus() {
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    async function refresh() {
      try {
        const reply = await api<StatusInfo>("/api/status")
        setDenied(reply.status === 403)
        if (reply.status === 200) setStatus(reply.body)
      } catch {
        setStatus({ caddyReachable: false, auth: { mode: "none" } })
      }
    }
    void refresh()
    const timer = setInterval(refresh, 15_000)
    return () => clearInterval(timer)
  }, [])
  return { status, denied }
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
            No authentication. Anyone who can reach this page can change your proxy. Use the Tailscale profile to restrict it.
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

export default function App() {
  const [view, setView] = useState<View>(initialView)
  const [topBarSlot, setTopBarSlot] = useState<HTMLElement | null>(null)
  const caddyfile = useCaddyfile()
  const { status, denied } = useStatus()

  useEffect(() => {
    window.history.replaceState(null, "", `#${view}`)
  }, [view])

  if (denied) {
    return (
      <Empty className="h-svh">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Access denied</EmptyTitle>
          <EmptyDescription>
            This Tailscale user is not allowed to use Fairway.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const current = NAV.find((item) => item.id === view)!

  return (
    <SidebarProvider className="h-svh">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 p-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <FairwayLogo className="size-5" />
            </div>
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
          </SidebarMenu>
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

        <div hidden={view !== "logs"} className="min-h-0 flex-1">
          <LogsTab active={view === "logs"} />
        </div>
        </TopBarSlotProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}
