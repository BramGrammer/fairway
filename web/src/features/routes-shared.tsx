import {
  ArrowRightIcon,
  CircleQuestionMarkIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  MessageSquareIcon,
} from "lucide-react"

import { buttonVariants } from "@/components/ui/button"

/** The icon of each kind of destination. */
export const DEST_ICONS = {
  proxy: ArrowRightIcon,
  file: FolderIcon,
  redirect: CornerDownRightIcon,
  respond: MessageSquareIcon,
  other: CircleQuestionMarkIcon,
} as const

export const isDomain = (host: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)

export const hostLabel = (host: string) => (host === "*" ? "any host" : host)

/** An icon button that opens the host in a new tab; nothing for non-domain hosts. */
export function HostLink({ host }: { host: string }) {
  if (!isDomain(host)) return null
  return (
    <a
      href={`https://${host}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${host}`}
      className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
    >
      <ExternalLinkIcon />
    </a>
  )
}
