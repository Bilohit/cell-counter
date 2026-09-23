import { useEffect, useState } from "react"

type Fn = (active: boolean) => void
const subs = new Set<Fn>()
let active = false

export const cropBus = {
  emit(next: boolean) {
    if (next === active) return
    active = next
    subs.forEach(f => f(next))
  },
  subscribe(fn: Fn): () => void {
    subs.add(fn)
    return () => { subs.delete(fn) }
  },
  get active() { return active },
}

/** Reactive read of the shared crop-mode flag. */
export function useCropActive(): boolean {
  const [on, setOn] = useState(active)
  useEffect(() => cropBus.subscribe(setOn), [])
  return on
}
