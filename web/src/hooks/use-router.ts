import { createContext, useContext } from "react"

import type { Page, Params } from "@/lib/router"

type Patch = { [K in keyof Params]?: Params[K] | undefined }

export interface RouterApi {
  page: Page
  params: Params
  /** Goes to another page (pushes a history entry). Other pages' parameters are dropped. */
  navigate: (page: Page, params?: Params) => void
  /** Opens a panel: pushes a history entry, so Back closes it. */
  openPanel: (patch: Patch) => void
  /** Changes parameters without a new history entry. */
  replaceParams: (patch: Patch) => void
  /** Closes a panel: goes back when its opening entry is the previous one, otherwise replaces the URL. */
  closePanel: (keys: (keyof Params)[]) => void
  /** Props that make an <a> a real link with client-side navigation. */
  linkProps: (page: Page, params?: Params) => { href: string; onClick: (event: React.MouseEvent) => void }
}

export const RouterContext = createContext<RouterApi | null>(null)

export function useRouter(): RouterApi {
  const router = useContext(RouterContext)
  if (!router) throw new Error("useRouter needs a RouterProvider")
  return router
}
