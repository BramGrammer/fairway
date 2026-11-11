import { ChevronsUpDownIcon, LogOutIcon, MoonIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import { useIsDark } from "@/hooks/use-is-dark"
import { initials } from "@/lib/auth"

/** The signed-in Owner in the sidebar footer, with a menu for the dark mode and logging out. */
export function UserMenu({ user, onLogout }: { user: string; onLogout: () => void }) {
  const { isMobile } = useSidebar()
  const { setTheme } = useTheme()
  const dark = useIsDark()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip={user} className="data-popup-open:bg-sidebar-accent" />}>
            <Avatar>
              <AvatarFallback>{initials(user)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{user}</span>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-48 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              {/* Stays open, so the change can be seen. The switch only shows the state; the item toggles it. */}
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme(dark ? "light" : "dark")}>
                <MoonIcon />
                <span className="flex-1">Dark mode</span>
                <Switch size="sm" checked={dark} tabIndex={-1} aria-hidden className="pointer-events-none" />
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onLogout}>
                <LogOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
