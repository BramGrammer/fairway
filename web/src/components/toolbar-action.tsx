import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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
