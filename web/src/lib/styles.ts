/** Class strings shared by more than one component, so two bars that are meant
 *  to be the same control cannot drift apart one padding value at a time. */

/** The square icon button both bottom bars use. One size, one hover, one
 *  focus ring, whether it sits in the workbench or under the gallery. */
export const ICON_BUTTON =
  "flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-dim " +
  // `scale`, not `transform`: Tailwind v4's scale/translate utilities write the
  // STANDALONE CSS properties (`scale: .94`), and a transition list naming
  // `transform` does not cover them - the press used to snap while the colour
  // faded. Measured 2026-09-21; see TILE below, which had the same fault.
  "transition-[color,background-color,scale,box-shadow] duration-150 ease-out " +
  "hover:bg-panel-hover hover:text-foreground active:scale-[0.94] " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none " +
  "disabled:pointer-events-none disabled:opacity-40 motion-reduce:active:scale-100"

/** Armed is a state the eye should catch without reading: the one control that
 *  costs time announces that it now would. */
export const ICON_BUTTON_ARMED =
  "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"

/** An image tile, wherever the app shows one: a gallery card, a staged capture
 *  on the confirm screen, one half of an overlap on the review board. The same
 *  object, so the same weight, the same lift and the same curve - three copies
 *  of this recipe had already drifted to two different push-in scales and two
 *  different easings, which the eye reads as three different kinds of card.
 *
 *  ONE IDEA: a small lift. The tile rises 2 px and grows a shadow, and nothing
 *  else moves - the image inside is deliberately still. Chosen by the user from
 *  the four variants in `docs/mocks/2026-09-21-hover.html` (variant C) over the
 *  combination this used to be: a 3 px lift on one curve plus a 1.035 push-in
 *  on another plus a brightness lift, three things at two durations, which read
 *  as busy rather than responsive.
 *
 *  `translate`, NOT `transform`, in the transition list. Tailwind v4's
 *  `-translate-y-*` utilities write the standalone CSS `translate` property, so
 *  a list naming `transform` does not cover them: the lift jumped to its full
 *  height on the first frame while the shadow eased in behind it, which is
 *  exactly the "snaps to the raised state" this was reported as. MEASURED
 *  2026-09-21 in the real app (computed `translate` went 0 -> -3px between two
 *  samples 40 ms apart, with `transitionProperty: box-shadow, transform`).
 *  Anything added here that moves a tile must name the property it actually
 *  animates - `scale` and `rotate` are standalone in v4 too.
 *
 *  Paired with `TILE_MEDIA` on the image inside, and with `TILE_HOVER` or
 *  `TILE_HOVER_GROUP` depending on whether the tile is hovered directly or
 *  through a wrapper that owns the hover. Both say the same thing; only the
 *  variant prefix differs. */
export const TILE =
  "group relative block overflow-hidden rounded-[var(--radius)] " +
  "border border-transparent inset-ring inset-ring-line bg-panel2 text-left outline-none " +
  "transition-[box-shadow,translate] duration-[160ms] ease-[cubic-bezier(.2,.8,.2,1)] " +
  // Always on its own layer. Otherwise the hover translate promotes it only
  // while hovered, and a composited layer snaps to whole device pixels while an
  // unpromoted tile paints its image at its fractional column x: the picture
  // jumped 1 device px sideways inside a still frame on hover (measured
  // 2026-09-21, confirm screen, fractional zoom: frame dx 0, image dx -1).
  "will-change-transform " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
  "motion-reduce:transition-none"

/** The lift, for a tile that is hovered directly. */
export const TILE_HOVER =
  "motion-safe:hover:-translate-y-[2px] " +
  "motion-safe:hover:shadow-[0_12px_26px_-18px_var(--shadow)] " +
  // A press has to land somewhere. Without it the tile is still floating at the
  // top of its lift at the moment of the click, and the one gesture the user
  // actually committed to is the only one the card does not acknowledge.
  "motion-safe:active:translate-y-0 motion-safe:active:duration-[90ms] " +
  "motion-reduce:active:translate-y-0"

/** The same lift, for a tile whose hover is owned by a wrapping `group`. */
export const TILE_HOVER_GROUP =
  "motion-safe:group-hover:-translate-y-[2px] " +
  "motion-safe:group-hover:shadow-[0_12px_26px_-18px_var(--shadow)] " +
  "motion-safe:active:translate-y-0 motion-safe:active:duration-[90ms] " +
  "motion-reduce:active:translate-y-0"

/** The image inside a tile. Deliberately STILL: variant C moves the frame and
 *  leaves the picture alone, so the capture a researcher is reading does not
 *  drift under the pointer. The transition that remains is for `opacity` only,
 *  which the confirm screen uses to mark a staged capture as selected. */
export const TILE_MEDIA =
  "h-full w-full object-cover transition-opacity duration-200 ease-out " +
  "motion-reduce:transition-none"

/** The one bottom bar, whether it sits under the workbench or under the
 *  gallery: same metrics as each other to the pixel, so a control the user
 *  learned in one place lands exactly where they expect it in the other. One
 *  constant now enforces that, rather than a comment asking two copies to
 *  stay identical by hand. */
export const BAR =
  "flex min-h-[46px] flex-none items-center gap-3 border-t border-line bg-panel px-4 py-2"
