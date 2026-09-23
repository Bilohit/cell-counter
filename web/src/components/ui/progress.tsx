"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        // No `overflow-hidden`. A rounded box that clips a TRANSFORMED child
        // is composited, and the rounded mask is then rasterised at the layer's
        // own resolution: at a fractional browser zoom the corners come back
        // square and a hairline is left along the edge. Same fault the
        // concentration panel had. The bar is sized by WIDTH instead, so the
        // indicator stays inside its parent on its own and nothing needs
        // clipping. A progress bar updates a few times a second, so paying for
        // a layout-driven transition instead of a compositor one costs nothing.
        "relative h-2 w-full rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${value || 0}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
