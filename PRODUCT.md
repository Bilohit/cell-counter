# PRODUCT.md — Cell Counter

## What it is
Local web app that counts cells in EVOS/AMG microscope captures of a hemocytometer — an 8-bit grayscale TIF (1360 × 1024) straight from the EVOS software, or a PNG/JPG export of one. User copies the capture to the Mac, drops it into the app, gets a count with an overlay of detected cells. The gallery carries a concentration calculator: `web/src/lib/concentration.ts` owns the arithmetic and the browser computes cells/mL without a round trip. The arithmetic lives only there: `pipeline.concentration()` was deleted on 2026-09-05 and has no server-side equivalent.

## Users
Lab researchers, non-programmers. One primary user flow, used at the bench, quickly, repeatedly.

## Surface & mode
Single-page tool. Mode: **Operate** — task completion beats expression. Zero clutter, no marketing.

## Core flow
1. Drop or pick captures (`.tif`/`.tiff`, PNG, JPG). A single capture goes straight to the
   workbench with its count; two or more go through the confirm screen and land in the gallery.
   Auto-crop defaults off; manual crop stays for a single capture. The app groups overlapping
   captures into fields on its own (asking to confirm an ambiguous pair, or matching two picked by
   hand), and a gallery of thumbnails switches between fields.
2. Count appears with an overlay of the cells found. One detector control, the quality level
   (Quick, Normal, Finest); moving it is free and the Reprocess button is what counts. Every
   other pipeline parameter keeps its tuned default and is not shown.
3. Export the result (annotated-image ZIP, CSV, PDF, or point JSON) or save the session to resume later — both run client-side, offline.

## Constraints
- Backend: Python FastAPI + OpenCV pipeline (pipeline.py) with a learned detector in ml/ (default since 2026-09-04); tuned defaults, and the quality level is the only detector control on screen.
- Ships as a self-contained zip per OS (own CPython + wheels, ~150 MB Windows / ~260 MB Mac): nothing to install, no Python required, runs offline, launched by double-click script, opens in default browser.
- Assumption (labeled): ten named themes, chosen in Settings and persisted in localStorage; English only; any number of captures at once, auto-grouped into fields by overlap (two captures per field, stitched).
