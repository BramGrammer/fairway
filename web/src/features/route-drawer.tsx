import { useState, type ReactNode } from "react"
import { FileCodeIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SideDrawer } from "@/components/side-drawer"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HostLogsTab } from "@/features/host-logs-tab"
import { HostAlertsBlock } from "@/features/host-alerts"
import { TimelineStrip } from "@/features/timeline-strip"
import {
  activeTab,
  drawerTabs,
  type DrawerTab,
  type NodeKind,
} from "@/lib/route-drawer"
import { hostFromLabel, requestShowInEditor } from "@/lib/show-in-editor"

const KIND_LABELS: Record<NodeKind, string> = {
  host: "Host",
  rule: "Rule",
  destination: "Destination",
  group: "Group",
}

const TAB_LABELS: Record<DrawerTab, string> = { overview: "Overview", logs: "Logs" }

interface RouteDrawerProps {
  name: string
  kind: NodeKind
  onClose: () => void
  overview?: ReactNode
}

/** The details of one node of the Routes page, in a drawer over the right edge. */
export function RouteDrawer({ name, kind, overview, onClose }: RouteDrawerProps) {
  // Kept here so the choice survives moving to another host; kinds without the tab show the overview.
  const [selectedTab, setSelectedTab] = useState<DrawerTab>("overview")
  const tabs = drawerTabs(kind)
  const tab = activeTab(kind, selectedTab)

  return (
    <SideDrawer
      label={`${name} details`}
      fill={tab === "logs"}
      onClose={onClose}
      title={
        <>
          <h2 className="min-w-0 truncate font-mono text-lg font-semibold tracking-tight">{name}</h2>
          <Badge variant="secondary" className="h-6 px-2.5 text-xs">
            {KIND_LABELS[kind]}
          </Badge>
        </>
      }
      actions={
        kind === "host" && (
          <Button variant="outline" size="sm" onClick={() => requestShowInEditor(hostFromLabel(name))}>
            <FileCodeIcon data-icon="inline-start" />
            Show in editor
          </Button>
        )
      }
      tabs={
        tabs.length > 0 && (
          <Tabs value={tab} onValueChange={(value) => setSelectedTab(value as DrawerTab)} className="shrink-0 gap-0 border-b px-5">
            <TabsList variant="line" className="h-10 gap-5 p-0">
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id} className="h-full flex-none px-0 group-data-horizontal/tabs:after:-bottom-px">
                  {TAB_LABELS[id]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )
      }
    >
      {kind === "host" && tab === "overview" && (
        <div className="mb-4">
          <TimelineStrip host={hostFromLabel(name)} />
        </div>
      )}
      {kind === "host" && tab === "overview" && hostFromLabel(name) !== "*" && (
        <div className="mb-4">
          <HostAlertsBlock host={name} />
        </div>
      )}
      {tab === "logs" ? <HostLogsTab host={hostFromLabel(name)} /> : overview}
    </SideDrawer>
  )
}
