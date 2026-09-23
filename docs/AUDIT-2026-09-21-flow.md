# Flow audit — 2026-09-21

Read-only walk of the user journeys: pipeline-steps toggle, slider moves,
Reprocess, gallery ↔ single image, crop/exclude, reload. Ranked by user harm:
a wrong count or silently lost work above cosmetic confusion. Nothing here is
fixed without approval; the rows marked **(covered)** die as a side effect of
already-approved work in `docs/superpowers/plans/2026-09-21-uiux-cleanup.md`.

Spot-checked by hand: rows 1, 2, 3, 4 (see the evidence column). The rest are
read off the source and not reproduced in a browser.

**STATUS 2026-09-21, end of the UI pass: 19 of the 20 rows are fixed.** Row 14
is the exception and is not a defect - see its row. Rows 12 and 13 died with
item 9 (`showStages` stopped being a counting input), row 16 with item 6d (the
shortcut list that mis-stated the gesture was deleted), row 9 with item 1 (the
dock's typed overrides are cleared at page load) and row 20's `opacity` with
item 7a (the slider was deleted along with the overlay it faded).

| # | State | What the user sees | Why it's wrong | Evidence | Smallest fix |
|---|---|---|---|---|---|
| 1 | Gallery counted → open a card → Sidebar → toggle "Count inside triple line only" | Only the open image recounts; other cards keep their numbers, unmarked | `boundary` is a counting input but staleness is judged on `level` alone, so no card is marked and Reprocess offers nothing. The calculator then sums two counting rules into one cells/mL | `useGallery.tsx:957-959`, `useCounter.tsx:182`, `ReprocessBar.tsx:56-57` | Include `boundary` in the staleness test |
| 2 | Save a session at Finest → load it | Counts come back at Normal, silently | The session file records no quality level; `importSession` forces `galleryLevel`, which resets to the default | `useGallery.tsx:1183-1184`; no `level` key anywhere in `session.ts` | Store each item's level in the session file |
| 3 | Any session with counts → Ctrl+R or close the tab | Everything gone, including hand corrections | No `beforeunload` guard, while the far less destructive "New session" is confirmed by dialog | no `beforeunload` in `web/src`; cf. `GalleryGrid.tsx:510-537` | **Conflicts with the reload=reset decision.** Decide: guard, or accept the loss |
| 4 | Add a dot on a missed cell → Reprocess higher → "Keep my hand edits" | That cell carries two dots; total one too high | `dotsNow` pushes every added point with no proximity test against `f.centers`, although the mirror case (a stale removal) is explicitly ghosted | `geom.ts:45-56` (verified) | Drop an added dot now within `r` of a detection |
| 5 | Exclude squares → Crop, or Reprocess at another level | Different squares greyed, or none; total changes silently | `off` keys are `col,row` indices into the *displayed* grid, so a crop re-points them; out-of-range keys are dropped silently | `geom.ts:101-109`, `DotCanvas.tsx:76-80` | Key exclusions by original-px square centre |
| 6 | Workbench → next capture → that count fails | Previous capture's photo, dots and count under the new name | The catch path toasts and sets `status: "error"` but never clears `fields`; a number is attributed to the wrong image | `useCounter.tsx:171-177` | Clear `fields` on a failed count |
| 7 | Same as #6, after the toast fades | No Reprocess button at all | `armed` needs `field.level !== level`; after a failure `field` is the previous same-level field, so retry is unreachable | `ImageToolbar.tsx:65,92` | Also arm when `status === "error"` |
| 8 | Gallery batch running, one card already red → click it | The whole run stops; untouched cards cancel | `activate` routes a failed card to `reprocess([id])`, which aborts the shared controller | `GalleryGrid.tsx:592-600`, `useGallery.tsx:980-985` | Ignore a retry click while `runIds` is set |
| 9 | Type a calculator override → reload | Empty gallery, but a confident cells/mL for captures that no longer exist | Dock overrides live in `sessionStorage`, which survives reload; the counts do not | `concentration.ts:134-149` | **(covered — item 1)** |
| 10 | Workbench slider → Finest → Reprocess → back to gallery | Every card, including the one just recounted, shows a red "Finest → Normal" downgrade chip | `level` and `galleryLevel` are separate states behind identical bars; the gallery never learns what the workbench committed | `ImageToolbar.tsx:84` vs `ReprocessBar.tsx:90` | Raise `galleryLevel` when the workbench commits higher |
| 11 | Gallery Reprocess running → click a card in the run | It opens and counts again; the result is discarded | `openGalleryItem` sees `inFlight`, skips the seed, orders a second count; the write-back is then blocked by the `owned` guard. Both queue on one server lock | `useGallery.tsx:500-512,1013-1015` | Read-only card view while `runIds` holds it |
| 12 | Workbench with an image open → Settings → "Show pipeline steps" on, then off | A count starts behind the dialog, twice, up to ~7 s each | `stages` is a counting input, so a display switch counts — the rule the slider may not break, with no dialog and no "replaces the current count" | `useCounter.tsx:134-182` | **(covered — item 9 part 1)** |
| 13 | Gallery, no image open → "Show pipeline steps" on | Nothing happens, ever | The gallery always counts `stages: false` and renders no stages | `useGallery.tsx:268`, `StageStrip.tsx:25` | **(covered — item 9)**, plus a word on the switch |
| 14 | **NOT FIXED** — Crop → Apply, or Auto-crop, or Reset crop | An immediate recount replacing the card's number | Counting inputs handled like `stages`: no dialog, no "the number showing now will be gone", although Reprocess gates both | `useCounter.tsx:182,237` | **Left as is.** Nothing is destroyed - hand edits live in original px and survive a crop - Apply and Reset are already explicit acts on the image, and the count SHOULD change because the counted area did. A dialog here would only confirm what the user just asked for. Say so if you disagree and it goes in |
| 15 | Exclude squares → Reprocess → read the dialog | Only hand edits are offered keep/discard; exclusions unmentioned | Exclusions change the total as much as edits and survive unannounced | `ReprocessDialog.tsx:122-137` | Add "N excluded squares are kept" |
| 16 | Settings → read the shortcut list → click a square on the photo | A dot appears; the total goes **up** | The list says "Click a square — exclude it from the total"; the canvas click handler is the dot editor | `SettingsDialog.tsx:27`, `DotCanvas.tsx:126-133` | **(covered — item 6d deletes the list)** |
| 17 | Steps on → select any stage but the result → click a cell | Nothing happens, nothing says why | With a stage selected `DotCanvas` is unmounted and the hint suppressed, so the primary action fails silently | `Viewer.tsx:485-511` | One line: editing returns on the result view |
| 18 | A card the server refused, long reason | One truncated red line | `truncate` with no `title`, unlike `ProcessingScreen`'s row; the only actionable text is unreachable | `GalleryGrid.tsx:416-420` | Add `title={item.error}` |
| 19 | Move the slider to Finest, then press → | The slider snaps to the next image's level; the request is gone | `openFiles` overwrites `level` unconditionally, with no sign it was dropped | `useCounter.tsx:200` | Toast when `level !== countLevel` on navigate |
| 20 | Steps on, grid off, overlay 40 %, boundary off → reload | All four back at defaults | Theme, scale, burn-count and sidebar persist; these four sit in plain `useState`, so the app remembers some preferences and forgets others with no learnable pattern | `useCounter.tsx:42-45` vs `useSettings.ts:73-80` | Persist `showStages`/`showGrid` the same way (`opacity` **covered — item 7a deletes it**) |

Not verified from code alone: row 4's frequency depends on the detector placing
a centre within `diameter/2` of the hand-added point (the arithmetic
double-counts; how often was not measured), and row 11's wall-clock cost depends
on `_COUNT_LOCK` ordering under two concurrent clients.
