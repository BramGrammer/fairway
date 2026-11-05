import { cn } from "@/lib/utils"

/** A flag over a fairway: where every request is headed. Follows the current text colour. */
export function FairwayLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 6v15" />
      <path d="M4.5 25c4-3.2 8-3.2 11.5-1.2s7.5 2 11.5-1.2" />
      <path d="M11 6.5l10 3.6L11 13.7z" fill="currentColor" stroke="none" />
    </svg>
  )
}
