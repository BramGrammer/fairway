import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIcon,
  ClipboardCheckIcon,
  CircleAlertIcon,
  FileCodeIcon,
  HistoryIcon,
  RouteIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { TopBarSlotProvider, TopBarTitleSlotProvider } from "@/components/top-bar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { onAskAssistant, requestAssistant } from "@/lib/ask-assistant"
import { onShowInEditor } from "@/lib/show-in-editor"
import { AssistantPanel } from "@/features/assistant-panel"
import { EditorTab } from "@/features/editor-tab"
import { EventsTab } from "@/features/events-tab"
import { HistoryTab } from "@/features/history-tab"
import { LogsTab } from "@/features/logs-tab"
import { ReviewsTab } from "@/features/reviews-tab"
import { RoutesTab } from "@/features/routes-tab"
import { SettingsDialog } from "@/features/settings-dialog"
import { useAssistant } from "@/hooks/use-assistant"
import { useCaddyfile } from "@/hooks/use-caddyfile"
import { ToolbarDivider, ToolbarToggle } from "@/components/toolbar-action"
import { LoginView } from "@/components/login-form"
import { UserMenu } from "@/components/user-menu"
import { api, onSessionLost, type StatusInfo } from "@/lib/api"
import { LoginRequiredContext } from "@/lib/login-context"
import { reviewsAvailable } from "@/lib/reviews"
import type { AiPrice, AiSettingsReply } from "@/lib/ai-settings"
import { RouterProvider } from "@/components/router-provider"
import { useRouter } from "@/hooks/use-router"
import { pageTitle, type Page } from "@/lib/router"
import { decideGate, type AuthStatus, type Gate } from "@/lib/auth"

const NAV: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: "editor", label: "Editor", icon: FileCodeIcon },
  { id: "routes", label: "Routes", icon: RouteIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "events", label: "Events", icon: ActivityIcon },
  { id: "reviews", label: "Reviews", icon: ClipboardCheckIcon },
  { id: "logs", label: "Logs", icon: ScrollTextIcon },
]

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

/** What the AI settings make available: the Reviews page and the Assistant each need their model and a login. Read again when Settings closes. */
function useAiOffered(loginRequired: boolean, settingsOpen: boolean) {
  const [ready, setReady] = useState<{ assistant: boolean; review: boolean } | null>(null)
  const [price, setPrice] = useState<AiPrice | null>(null)
  useEffect(() => {
    if (settingsOpen) return
    let stopped = false
    api<AiSettingsReply>("/api/settings/ai", undefined, { background: true })
      .then(({ body }) => {
        if (stopped) return
        setReady(body.ok ? body.ready : { assistant: false, review: false })
        setPrice(body.ok ? body.assistantPrice : null)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [settingsOpen])
  return {
    reviews: reviewsAvailable(ready?.review ?? false, loginRequired),
    assistant: loginRequired && (ready?.assistant ?? false),
    known: ready !== null,
    price,
  }
}

/** A dot for Caddy's state: green while it is reachable, a pulsing red when it is not. */
function StatusDot({ status, className }: { status: StatusInfo | null; className?: string }) {
  if (status === null) return null
  const label = status.caddyReachable ? "Caddy connected" : "Caddy unreachable"
  return (
    <Tooltip>
      {/* The pseudo element widens the area that shows the tooltip beyond the small dot. */}
      <TooltipTrigger
        render={<span role="status" className={cn("relative flex size-2 shrink-0 after:absolute after:-inset-1.5", className)} />}
      >
        <span className="sr-only">{label}</span>
        {!status.caddyReachable && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60" />
        )}
        <span
          className={cn("relative inline-flex size-full rounded-full", status.caddyReachable ? "bg-success" : "bg-destructive")}
        />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/** Shown only when login is off. A full alert while the sidebar is open, an icon with a tooltip while it is collapsed. */
function NoAuthAlert() {
  return (
    <>
      <Alert variant="destructive" className="group-data-[collapsible=icon]:hidden">
        <ShieldAlertIcon />
        <AlertTitle>No authentication</AlertTitle>
        <AlertDescription className="text-xs">
          Anyone who can reach this page can change your proxy. Restrict access at the network layer.
        </AlertDescription>
      </Alert>
      <Tooltip>
        <TooltipTrigger
          render={<div className="hidden items-center justify-center text-destructive group-data-[collapsible=icon]:flex" />}
        >
          <ShieldAlertIcon className="size-4" aria-label="No authentication" />
        </TooltipTrigger>
        <TooltipContent side="right">
          No authentication. Anyone who can reach this page can change your proxy.
        </TooltipContent>
      </Tooltip>
      <Separator />
    </>
  )
}

function Editor({ user, onLogout }: { user: string | null; onLogout: () => void }) {
  const { page: view, params, navigate, openPanel, replaceParams, closePanel, linkProps } = useRouter()
  const [topBarSlot, setTopBarSlot] = useState<HTMLElement | null>(null)
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const caddyfile = useCaddyfile()
  const status = useStatus()
  const loginRequired = user !== null
  const { reviews: reviewsOffered, assistant: assistantOffered, known: reviewsKnown, price: assistantPrice } = useAiOffered(loginRequired, params.settings !== undefined)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // The Assistant reads the editor buffer as it is when a turn is sent.
  const textRef = useRef(caddyfile.text)
  useEffect(() => {
    textRef.current = caddyfile.text
  }, [caddyfile.text])
  const getText = useCallback(() => textRef.current, [])
  // Held here, not in the panel, so closing the panel does not drop the Conversation.
  const assistant = useAssistant(getText, caddyfile.text)
  const nav = NAV.filter((item) => item.id !== "reviews" || reviewsOffered)

  useEffect(() => onShowInEditor(() => navigate("editor")), [navigate])

  // A request from elsewhere in the app, such as a Review, to ask the Assistant: it opens on a new Conversation.
  const { startWith } = assistant
  useEffect(
    () =>
      assistantOffered
        ? onAskAssistant((message) => {
            setAssistantOpen(true)
            void startWith(message)
          })
        : undefined,
    [assistantOffered, startWith]
  )

  // A link to Reviews while they are not offered (no model, no login) goes to the editor.
  useEffect(() => {
    if (view === "reviews" && reviewsKnown && !reviewsOffered) navigate("editor")
  }, [view, reviewsKnown, reviewsOffered, navigate])

  useEffect(() => {
    document.title = pageTitle(view)
  }, [view])

  const current = NAV.find((item) => item.id === view)!

  return (
    <SidebarProvider className="h-svh">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 p-1">
            <div className="relative shrink-0">
              <FairwayLogo className="size-8 text-primary" />
              {/* The name is hidden while the sidebar is collapsed, so the dot moves onto the logo then. */}
              <StatusDot
                status={status}
                className="absolute top-0 -right-0.5 hidden size-2.5 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:flex"
              />
            </div>
            <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="flex items-center gap-1.5 font-heading font-semibold">
                <span className="truncate">Fairway</span>
                <StatusDot status={status} />
              </span>
              <span className="truncate text-xs text-muted-foreground">Caddy control</span>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Caddyfile</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={view === item.id}
                      tooltip={item.label}
                      render={<a {...linkProps(item.id)} />}
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
          {status?.auth.mode === "none" && <NoAuthAlert />}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Settings" onClick={() => openPanel({ settings: "general" })}>
                <SettingsIcon />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {user !== null && <UserMenu user={user} onLogout={onLogout} />}
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className={cn("h-svh min-w-0 overflow-hidden md:h-[calc(100svh-1rem)]", assistantOffered && assistantOpen && "md:peer-data-[variant=inset]:mr-0")}>
        <TopBarSlotProvider value={topBarSlot}>
        <TopBarTitleSlotProvider value={titleSlot}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <h1 className="font-heading font-medium">{current.label}</h1>
          <div ref={setTitleSlot} className="flex shrink-0 items-center gap-2" />
          {/* The padding, undone by the negative margin, leaves room for the 1px a pressed button moves and for focus rings; without it they overflow and a scrollbar appears. */}
          <div ref={setTopBarSlot} className="-mr-1 -my-1 ml-auto flex min-w-0 items-center gap-2 overflow-x-auto p-1" />
          {assistantOffered && (
            <>
              <ToolbarDivider />
              <ToolbarToggle label="Assistant" pressed={assistantOpen} onPressedChange={setAssistantOpen}>
                <SparklesIcon />
              </ToolbarToggle>
            </>
          )}
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
                navigate("editor")
              }}
              onRolledBack={caddyfile.load}
            />
          </div>
        )}

        {view === "reviews" && reviewsOffered && (
          <div className="min-h-0 flex-1">
            <ReviewsTab onAskAssistant={assistantOffered ? requestAssistant : undefined} />
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
        </TopBarTitleSlotProvider>
        </TopBarSlotProvider>
      </SidebarInset>
      {assistantOffered && assistantOpen && (
        <AssistantPanel
          assistant={assistant}
          price={assistantPrice}
          onAccept={(text) => {
            caddyfile.setText(text)
            navigate("editor")
          }}
          onClose={() => setAssistantOpen(false)}
        />
      )}
      <SettingsDialog
        category={params.settings ?? null}
        onCategoryChange={(settings) => replaceParams({ settings })}
        onClose={() => closePanel(["settings"])}
        user={user}
      />
    </SidebarProvider>
  )
}

/** Decides between the login view and the editor. The editor remounts after a sign in, so unsaved text is dropped. */
function Gate() {
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

export default function App() {
  return (
    <RouterProvider>
      <Gate />
    </RouterProvider>
  )
}
