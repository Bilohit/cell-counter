import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MotionConfig } from "framer-motion"
import "./index.css"
import App from "./App"
import { clearDock } from "@/lib/concentration"

// A page load starts an empty session: the captures, the counts and the hand
// corrections all live in React state and went with the previous page. The
// concentration dock's typed overrides did NOT - they sit in sessionStorage,
// which survives a reload - so they used to come back describing counts that
// no longer exist (flow audit 2026-09-21, row 9). Cleared here, before the
// first render, so no component can read the stale value on its way up.
clearDock()

// One place decides motion for the whole app. The CSS fallback in index.css can
// only stop CSS animation; framer-motion drives transforms from JS and ignores
// it, so a reader who asked their system for less motion still got the full
// thing. `reducedMotion="user"` makes every motion component honour that
// preference without each one having to remember to ask.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)
