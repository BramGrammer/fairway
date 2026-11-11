import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PRESSED } from "@/lib/toggle-styles"
import { cn } from "@/lib/utils"

/** An icon-only button of the top bar; its name, and its shortcut if it has one, show in a tooltip. */
export function ToolbarAction({
  label,
  keys,
  variant = "outline",
  disabled,
  onClick,
  children,
}: {
  label: string
  keys?: string[]
  variant?: "outline" | "ghost"
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      {/* The span keeps the tooltip working while the button is disabled. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button variant={variant} size="icon" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys && (
          <KbdGroup>
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** An icon-only toggle of the top bar: it looks pressed while it is on, and its name shows in a tooltip. */
export function ToolbarToggle({
  label,
  pressed,
  onPressedChange,
  children,
}: {
  label: string
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="outline"
            className={cn(PRESSED, "size-8 px-0")}
            aria-label={label}
            pressed={pressed}
            onPressedChange={onPressedChange}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
