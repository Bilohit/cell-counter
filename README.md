<h1 align="center">Cell Counter</h1>

<p align="center">
  Automatic cell counts for hemocytometer captures.<br>
  Drop in your microscope images, get a checked count and cells/mL. Nothing leaves your computer.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS-0B6E77?style=flat-square" alt="Windows and macOS">
  <img src="https://img.shields.io/badge/works-offline-0B6E77?style=flat-square" alt="Works offline">
  <img src="https://img.shields.io/badge/install-none-0B6E77?style=flat-square" alt="Nothing to install">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B6E77?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <strong>2.2 % average error per square &middot; no systematic over- or under-count &middot; under 2 seconds per capture</strong><br>
  <sub>Checked against 15,624 hand-counted cells on 69 squares, scoring only squares the model never trained on. Speed measured in the app itself, start to finish, 64 captures on an ordinary laptop with no graphics card. <a href="#how-accurate-is-it">Details</a></sub>
</p>

---

Counting a hemocytometer by hand is slow, tiring and hard to repeat exactly.
Cell Counter finds every cell in an
EVOS / AMG 10x capture, marks each one with a dot you can check, applies the
standard boundary rule, and turns the result into a concentration.

- **Fast.** Under 2 seconds per capture, pairing and counting included: 64 captures in under 2 minutes.
- **Checkable.** Every counted cell is marked, so you see exactly what was counted, and you can fix any dot with a click.
- **Consistent.** The same image at the same setting gives the same count every time.
- **Private.** It runs entirely on your computer. No account, no upload, no internet.

## Install

1. Download the app for your computer:
   **[Windows](../../releases/latest/download/CellCounter-Windows.zip)** or
   **[macOS](../../releases/latest/download/CellCounter-macOS.zip)**.
2. Unzip it anywhere, for example your Desktop.
3. Open **READ ME FIRST.txt** inside the folder. It walks you through the first
   start and a first count, step by step.
4. Double-click **Start Cell Counter** (`.bat` on Windows, `.command` on macOS).

Your web browser opens with the app. Nothing else to install: the zip carries
everything it needs, and it works without internet.

**On a Mac**, the first time, macOS may say the file is from an unidentified
developer. Right-click it, choose **Open**, then **Open** again. You only do this once.

To quit, close the black terminal window.

## Use it

**Name your files by sample.** Start every file name with the sample's name and
a space, so all captures of one sample begin with the same word:

```text
ha1 sq1.1.tif   ha1 sq1.2.tif   ha1 sq2.1.tif   ...
KNT sq1.1.tif   KNT sq1.2.tif   ...
```

Any word works (`ha1`, `KNT`, `abc`); capitals don't matter. Turn on **Name
groups** on the confirm screen and the app only compares captures within a
sample, which is much faster on a big folder, and the concentration calculator
works one sample at a time. Files named some other way can still be grouped by
hand: select them and choose **New group**.

**Load captures.** Drag TIF files onto the window, or click to browse. Load a
whole folder at once. A 10x capture shows three of a square's four rows, so a
square is usually captured twice: the app finds the two overlapping captures
by itself, joins them, and counts the square once.

**Check the count.** Each field shows its count, the detected grid, and a dot on
every counted cell. Only cells inside the triple boundary line are counted, the
standard hemocytometer rule.

**Fix anything it got wrong.** Click a dot to remove it, click a cell to add one.
Your corrections stay put when you crop or change the view. Reprocess counts from
scratch and replaces them.

**Get the concentration.** The built-in calculator turns the counted squares into
cells/mL once you type your dilution. It only uses complete squares and tells you
which ones it left out and why.

**Export.** Annotated images, a CSV of the counts, a PDF report, or the cell
positions as JSON. You can also save the session and pick it up later. Closing
or reloading the browser tab clears the counts, so export or save first.

### Three settings

One slider trades speed for care. Moving it is free; press **Reprocess** to count again.

| Setting | Per capture | 32 captures (16 squares) | Use it for |
| --- | --- | --- | --- |
| Quick | 0.7 s | 13 s | a first look |
| **Normal** | **1.5 s** | **34 s** | **everyday counting (default)** |
| Finest | 9.5 s | 4 min | final numbers, crowded slides |

<sub>Measured 2026-09-23 on a laptop CPU (Intel i7-14650HX), no graphics card. A smaller laptop will be slower.</sub>

### Getting good captures

- Focus on the cells, not the grid lines.
- Keep the triple boundary line in the frame. It is the counting boundary.
- Keep the lighting even. Strong gradients cost more accuracy than anything else.
- Use the TIF straight from the microscope rather than a re-saved JPG.

Works with EVOS / AMG 10x captures: 8-bit grayscale TIF, 1360 × 1024, or a PNG / JPG export of one.

## How accurate is it

The model was tested the strict way: whole batches of slides were held back,
the model was trained without them, and its counts on those unseen squares were
compared with careful hand counts. This was repeated for 10 separate batches.

| On squares it had never seen | Result |
| --- | --- |
| Average error per square | **2.2 %** (about 5 cells on a typical 226-cell square) |
| Tendency to over- or under-count | **+0.1 %**, effectively none |
| Worst single square | 7.6 % |
| Range across the 10 batches | 0.6 % to 3.6 % |
| Cell-by-cell agreement with the hand counts (F1) | 0.965 |

No systematic bias matters most. A hemocytometer count averages several squares,
so random errors on single squares largely cancel out, while a steady over-count
would carry straight into your cells/mL. Cell Counter has no such lean.

Hand counts are not perfect either: annotators miss some pale cells, so part of
the measured error belongs to the reference, not the app.

**Always look at the dots before you trust a number**, especially on an unusual
slide: heavy debris, dense clumps, uneven lighting, or cells sitting on grid lines.

### Known limits

- Very dense or clumped fields undercount. Two touching cells can be read as one.
- Pale or out-of-focus cells are missed more often than bright ones.
- If the grid or the triple line cannot be found, the capture is declined rather than guessed at. Re-capture it.
- Tuned and tested on 10x captures only. 4x captures are untested.
- The model learned from a limited set of slides. Cells that look very different from those may count worse, and nothing on screen will warn you.

Full measurement history: [docs/accuracy-evidence.md](docs/accuracy-evidence.md) and the experiment log [ml/runs/loo.md](ml/runs/loo.md).

<details>
<summary><strong>For developers</strong></summary>

Running from source needs Python 3.12+ and Node. The launchers at the repo root
build a `.venv` on first run; the ones in a release zip carry their own Python.

```bash
pip install -r requirements.txt            # add requirements-train.txt to train
cd web && npm install && npm run build     # builds the UI into static/dist
python app.py                              # http://127.0.0.1:8477
```

```bash
python -m pytest                           # tests/{api,pipeline,ml,tools}
cd web && npm test
python tools/build_release.py              # release zips, needs internet
```

Tests marked `data` need annotated captures in `data/tif` and `data/gt`, which
are not published; they skip on a checkout without them.

Design history lives in [docs/](docs/). Accuracy claims use grouped
cross-validation (`python -m ml.loo`), never `score.py`, which scores the shipped
weights on their own training tiles.

</details>

## License

[MIT](LICENSE). Bundled fonts are under the [SIL Open Font License](web/public/fonts/OFL.txt).
