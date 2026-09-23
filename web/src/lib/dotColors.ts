/** The dot palette, owned in one place because it has two consumers that cannot
 *  read a CSS custom property: the canvas overlay (`DotCanvas`) draws with it,
 *  and the exporters burn it into the saved image. A burned-in export must be
 *  the screen the user approved, so the two can never be allowed to drift. */
export const DOT_AUTO = "#ff8c3c"
export const DOT_ADDED = "#4ade80"
