import { createContext } from "react"

/** Whether Fairway asks for the Owner's login. False when it runs open, with no credentials set. */
export const LoginRequiredContext = createContext(false)
