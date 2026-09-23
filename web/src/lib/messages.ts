// This file exists so a user-facing sentence spoken from more than one place
// (here, useCounter.tsx and useGallery.tsx) is written once, not copied. A new
// shared sentence belongs here, not re-typed at each call site, or the two
// copies will eventually drift and say two different things about one event.
export const REFUSED_STITCH_MSG = "These two captures did not stitch, so they cannot be counted as one."
