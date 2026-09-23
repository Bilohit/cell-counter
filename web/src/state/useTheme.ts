import { useCallback, useEffect, useState } from "react"

export interface Theme { id: string; name: string; bg: string; accent: string; light?: boolean }

// Ported from Second Thought; the tokens themselves live in index.css.
export const THEMES: Theme[] = [
  { id: "", name: "Default", bg: "#0b0f14", accent: "#51d98b" },
  { id: "void", name: "Void", bg: "#050505", accent: "#7d7d7d" },
  { id: "mist", name: "Mist", bg: "#181c1d", accent: "#6cb8b1" },
  { id: "lilac", name: "Lilac", bg: "#1c1620", accent: "#c08fdd" },
  { id: "sand", name: "Sand", bg: "#1e1a16", accent: "#cf9e5c" },
  { id: "wine", name: "Wine", bg: "#160a0e", accent: "#a8415f" },
  { id: "paper", name: "Paper", bg: "#ffffff", accent: "#737373", light: true },
  { id: "sage", name: "Sage", bg: "#f6f8f3", accent: "#779659", light: true },
  { id: "sky", name: "Sky", bg: "#eef6fb", accent: "#2f96ca", light: true },
  { id: "bubba-pink", name: "Bubba Pink", bg: "#fdf6f8", accent: "#a2556f", light: true },
]

const KEY = "cellcounter-theme"

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(KEY) ?? ""
      return THEMES.some(t => t.id === saved) ? saved : ""
    } catch { return "" }
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme) root.setAttribute("data-theme", theme)
    else root.removeAttribute("data-theme")
    // shadcn's dark variants key off this, so light themes get light components.
    root.setAttribute("data-scheme", THEMES.find(t => t.id === theme)?.light ? "light" : "dark")
    try { localStorage.setItem(KEY, theme) } catch { /* private mode */ }
  }, [theme])

  return { theme, setTheme: useCallback((id: string) => setTheme(id), []) }
}
