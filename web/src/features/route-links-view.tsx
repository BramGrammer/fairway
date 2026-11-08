import { CopyIcon, ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { Link } from "@/lib/route-links"

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${text}`)
  } catch {
    toast.error("Could not copy to the clipboard")
  }
}

/** Open and Copy actions for each link; renders nothing when there are none. */
export function LinkActions({ links, labelled = true }: { links: Link[]; labelled?: boolean }) {
  if (links.length === 0) return null
  return (
    <ul className={labelled ? "flex flex-col gap-1" : "flex items-center"}>
      {links.map((link) => (
        <li key={link.url} className="flex items-center gap-2">
          {labelled && <span className="min-w-0 truncate font-mono text-xs">{link.label}</span>}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Open ${link.url}`}
            render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
            nativeButton={false}
          >
            <ExternalLinkIcon />
          </Button>
          {link.copy !== null && (
            <Button variant="ghost" size="icon-sm" aria-label={`Copy ${link.copy}`} onClick={() => void copy(link.copy!)}>
              <CopyIcon />
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
