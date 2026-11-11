import { WandSparklesIcon } from "lucide-react"

import { SideDrawer } from "@/components/side-drawer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { isFormatting, type Finding } from "@/lib/findings"

interface FindingsDrawerProps {
  /** Already sorted, errors first. */
  findings: Finding[]
  onJump: (line: number) => void
  onFormat: () => void
  formatting: boolean
  onClose: () => void
}

/** Every Finding about the Caddyfile being edited, in a drawer over the right edge of the editor. */
export function FindingsDrawer({ findings, onJump, onFormat, formatting, onClose }: FindingsDrawerProps) {
  return (
    <SideDrawer
      label="Findings"
      flush
      onClose={onClose}
      title={
        <>
          <h2 className="text-lg font-semibold tracking-tight">Findings</h2>
          <Badge variant="secondary" className="h-6 px-2.5 text-xs">
            {findings.length}
          </Badge>
        </>
      }
      actions={
        findings.some(isFormatting) && (
          <Button variant="outline" size="sm" onClick={onFormat} disabled={formatting}>
            <WandSparklesIcon data-icon="inline-start" />
            Format now
          </Button>
        )
      }
    >
      <Table className="text-xs [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-5 [&_th:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:last-child]:pr-5">
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Level</TableHead>
            <TableHead className="w-14">Line</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((finding, index) => {
            const line = finding.line
            return (
              <TableRow
                key={index}
                className={line === undefined ? undefined : "cursor-pointer"}
                onClick={line === undefined ? undefined : () => onJump(line)}
              >
                <TableCell className="align-top">
                  <Badge variant={finding.level === "error" ? "destructive" : "warning"} className="-ml-2 font-mono">
                    {finding.level === "error" ? "ERR" : "WARN"}
                  </Badge>
                </TableCell>
                <TableCell className="align-top font-mono text-muted-foreground">{line ?? "–"}</TableCell>
                <TableCell className="break-words whitespace-normal">{finding.message}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </SideDrawer>
  )
}
