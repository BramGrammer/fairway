/** Orders the columns of the routes graph so that as few lines as possible cross. */

/** Nodes that must stay next to each other, like the hosts of one domain. */
export interface Unit {
  key: string
  members: string[]
}

/** Columns from left to right, each a list of units. */
export type Layers = Unit[][]

/** A line between two nodes in neighbouring columns. */
export type Link = [from: string, to: string]

const flat = (units: Unit[]) => units.flatMap((unit) => unit.members)

function ranks(units: Unit[]): Map<string, number> {
  return new Map(flat(units).map((id, i) => [id, i]))
}

/** Lines between two columns that cross, given each line's position at both ends. */
function crossings(edges: [number, number][]): number {
  let count = 0
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if ((edges[i][0] - edges[j][0]) * (edges[i][1] - edges[j][1]) < 0) count++
    }
  }
  return count
}

function unique(links: Link[]): Link[] {
  return [...new Map(links.map((link) => [link.join(">"), link])).values()]
}

/** Groups links by the column they start in; every link must join neighbouring columns. */
function byColumn(links: Link[], layers: Layers): Link[][] {
  const column = new Map(layers.flatMap((units, i) => flat(units).map((id): [string, number] => [id, i])))
  const groups: Link[][] = layers.map(() => [])
  for (const link of unique(links)) {
    const from = column.get(link[0])
    const to = column.get(link[1])
    if (from === undefined || to === undefined) continue
    if (to === from + 1) groups[from].push(link)
    else if (from === to + 1) groups[to].push([link[1], link[0]])
  }
  return groups
}

function crossingsAt(groups: Link[][], layers: Layers, column: number): number {
  const edges = groups[column]
  if (!edges || edges.length === 0 || column + 1 >= layers.length) return 0
  const left = ranks(layers[column])
  const right = ranks(layers[column + 1])
  return crossings(edges.map(([a, b]): [number, number] => [left.get(a) ?? 0, right.get(b) ?? 0]))
}

export function countCrossings(links: Link[], layers: Layers): number {
  const groups = byColumn(links, layers)
  return layers.reduce((sum, _, column) => sum + crossingsAt(groups, layers, column), 0)
}

const copy = (layers: Layers): Layers =>
  layers.map((units) => units.map((unit) => ({ ...unit, members: [...unit.members] })))

/** Sorts by average neighbour position; nodes without neighbours, and ties, keep their place. */
function byCenter<T>(items: T[], center: (item: T) => number | null): T[] {
  return items
    .map((item, i) => ({ item, i, c: center(item) }))
    .sort((a, b) => (a.c ?? a.i) - (b.c ?? b.i) || a.i - b.i)
    .map((entry) => entry.item)
}

/**
 * Layered crossing reduction: sweep back and forth with barycenters (each node moves towards the
 * average position of what it connects to), keep the best order seen, then swap neighbours while
 * that helps. Never returns something worse than `start`.
 */
export function orderLayers(links: Link[], start: Layers): Layers {
  const all = unique(links)
  const neighbours = new Map<string, string[]>()
  for (const [a, b] of all) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b])
    neighbours.set(b, [...(neighbours.get(b) ?? []), a])
  }

  let best = copy(start)
  let bestScore = countCrossings(all, best)
  const current = copy(start)

  /** Reorders one column by the positions of its neighbours in the column next to it. */
  const settle = (column: number, reference: number) => {
    const positions = ranks(current[reference])
    const size = Math.max(positions.size, 1)
    const center = (id: string) => {
      const found = (neighbours.get(id) ?? []).filter((n) => positions.has(n))
      return found.length === 0 ? null : found.reduce((sum, n) => sum + (positions.get(n) ?? 0), 0) / found.length / size
    }
    const members = current[column].map((unit) => ({ ...unit, members: byCenter(unit.members, center) }))
    current[column] = byCenter(members, (unit) => {
      const values = unit.members.map(center).filter((v): v is number => v !== null)
      return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null
    })
  }

  for (let sweep = 0; sweep < 24 && bestScore > 0; sweep++) {
    if (sweep % 2 === 0) for (let i = 1; i < current.length; i++) settle(i, i - 1)
    else for (let i = current.length - 2; i >= 0; i--) settle(i, i + 1)
    const score = countCrossings(all, current)
    if (score < bestScore) {
      best = copy(current)
      bestScore = score
    }
  }

  // Greedy neighbour swaps on the best order found.
  const groups = byColumn(all, best)
  const local = (column: number) => crossingsAt(groups, best, column - 1) + crossingsAt(groups, best, column)
  const trySwaps = (): boolean => {
    let improved = false
    const attempt = (list: unknown[], i: number, column: number) => {
      const before = local(column)
      ;[list[i], list[i + 1]] = [list[i + 1], list[i]]
      if (local(column) < before) improved = true
      else [list[i], list[i + 1]] = [list[i + 1], list[i]]
    }
    best.forEach((units, column) => {
      for (let i = 0; i < units.length - 1; i++) attempt(units, i, column)
      for (const unit of units) for (let i = 0; i < unit.members.length - 1; i++) attempt(unit.members, i, column)
    })
    return improved
  }
  for (let pass = 0; pass < 12 && trySwaps(); pass++);

  return best
}
