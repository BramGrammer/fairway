import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useIsDark } from "@/hooks/use-is-dark"

function Shell() {
  const dark = useIsDark()
  return (
    <TooltipProvider>
      <App />
      <Toaster theme={dark ? "dark" : "light"} position="bottom-right" />
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  </StrictMode>
)
