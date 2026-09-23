import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabel,
  thumbValueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  // Radix puts role="slider" on the THUMB, so a name set on the root names a
  // group the keyboard never lands on. These reach the thumb itself, which is
  // what a screen reader announces.
  thumbLabel?: string
  thumbValueText?: string
}) {
  // Radix positions the thumb with `left:` on a wrapper span it renders itself,
  // and sizes the range with `left`/`right` - none of which it transitions. So
  // the handle teleported between rungs: correct, and unpolished, on a control
  // whose whole job is to be moved (measured in the real app 2026-09-21, the
  // wrapper's inline style is `left: calc(N% + Mpx)`).
  //
  // It animates only when the value moves WITHOUT the pointer dragging it: a
  // keyboard arrow, or a click on the far end of the track. During a real drag
  // the handle must sit exactly under the finger, and an eased handle lags it.
  // `dragging` is therefore set on the first pointermove AFTER a pointerdown,
  // not on the pointerdown itself - so a plain click still animates across.
  const [dragging, setDragging] = React.useState(false)
  const down = React.useRef(false)
  React.useEffect(() => {
    if (!down.current && !dragging) return
    const up = () => { down.current = false; setDragging(false) }
    // On the window, not the element: a drag that ends off the control - which
    // is most of them, since the pointer is captured - never fires pointerup on
    // it, and the transition would stay off until the next drag.
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [dragging])

  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-dragging={dragging || undefined}
      onPointerDown={e => { down.current = true; props.onPointerDown?.(e) }}
      onPointerMove={e => { if (down.current && !dragging) setDragging(true); props.onPointerMove?.(e) }}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        // The thumb's wrapper is Radix's own span - the only direct child that
        // is not the track - so it is addressed by what it is not, rather than
        // by a `:has()` the older Firefox in the release zip may not have.
        "[&>span:not([data-slot=slider-track])]:transition-[left,right]",
        "[&>span:not([data-slot=slider-track])]:duration-[190ms]",
        "[&>span:not([data-slot=slider-track])]:ease-[cubic-bezier(.2,.8,.2,1)]",
        "[&_[data-slot=slider-range]]:transition-[left,right]",
        "[&_[data-slot=slider-range]]:duration-[190ms]",
        "[&_[data-slot=slider-range]]:ease-[cubic-bezier(.2,.8,.2,1)]",
        // Under the finger, nothing eases: the handle has to be where the
        // pointer is. Same for a reader who asked for less motion.
        "data-[dragging]:[&_*]:transition-none",
        "motion-reduce:[&_*]:transition-none",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          // No `overflow-hidden`: the range is inset inside the track and has
          // nothing to overflow, and a rounded clip over a child placed at a
          // fractional percentage leaves a stray square corner at some browser
          // zooms. The range carries its own radius instead.
          "relative grow rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute rounded-full bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={thumbLabel}
          aria-valuetext={thumbValueText}
          // An INSET ring, never a coloured border: Zen/WebRender seams a real
          // border at a rounded corner (measured 2026-09-19, see
          // _constraints.md). transition-[color,box-shadow] already covers
          // box-shadow, so the ring needs no further change there.
          // bg-clip-padding: the white fill otherwise runs under the 1px
          // transparent border, outside the ring, and the handle read as a
          // white disc with a green circle drawn inside it (2026-09-21).
          className="block size-4 shrink-0 rounded-full border border-transparent bg-clip-padding inset-ring inset-ring-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
