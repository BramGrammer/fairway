import { flexRender, type Table as TanstackTable } from "@tanstack/react-table"

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface DataTableProps<TData> {
  table: TanstackTable<TData>
  /** Shown when there are no rows. */
  empty?: string
}

/**
 * Renders a TanStack table with the shadcn table parts. It draws the bare `<table>`
 * (not the `Table` wrapper) so the header can stick to the top of an outer scroll area.
 */
export function DataTable<TData>({ table, empty = "No results." }: DataTableProps<TData>) {
  const rows = table.getRowModel().rows
  return (
    <table data-slot="table" className="w-full caption-bottom text-sm">
      <TableHeader className="sticky top-0 z-10 bg-background">
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => (
              <TableHead key={header.id} className="first:pl-4 last:pr-4">
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length > 0 ? (
          rows.map((row) => (
            <TableRow key={row.id} className="group/row">
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="h-10 py-0 whitespace-nowrap first:pl-4 last:pr-4">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={table.getVisibleLeafColumns().length || 1} className="h-24 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </table>
  )
}
