import numpy as np

import score


def test_match_returns_pairs_not_count():
    det = np.array([[10.0, 10.0]])
    gt = np.array([[11.0, 10.0]])
    assert score.match(det, gt, 5.0) == [(0, 0)]


def test_match_respects_radius():
    det = np.array([[10.0, 10.0]])
    gt = np.array([[30.0, 10.0]])
    assert score.match(det, gt, 5.0) == []


def test_match_is_one_to_one():
    det = np.array([[10.0, 10.0], [11.0, 10.0]])
    gt = np.array([[10.5, 10.0]])
    assert len(score.match(det, gt, 5.0)) == 1


def test_match_is_optimal_not_greedy():
    """Greedy takes the globally shortest pair first and starves the rest.

    det A is 1 px from gt X and 4 px from gt Y; det B can only reach X.
    Greedy pairs A-X (shortest overall) and leaves B unmatched -> 1 pair.
    Optimal pairs B-X and A-Y -> 2 pairs. Measured cost of greedy on the
    real tiles: 4 lost TP, the same size as the deltas this scorer judges.
    """
    det = np.array([[10.0, 10.0], [12.0, 10.0]])   # A, B
    gt = np.array([[11.0, 10.0], [14.0, 10.0]])    # X, Y
    assert len(score.match(det, gt, 3.0)) == 2


def test_match_empty_inputs():
    empty = np.zeros((0, 2))
    assert score.match(empty, np.array([[1.0, 1.0]]), 5.0) == []
    assert score.match(np.array([[1.0, 1.0]]), empty, 5.0) == []


def test_load_gt_without_pale_list(tmp_path):
    """Old-format GT files (no 'pale' key) must still load, pale empty."""
    import json
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"image": "x.tif", "points": [[1, 2], [3, 4]]}))
    name, pts, pale = score.load_gt(str(p))
    assert name == "x.tif"
    assert pts.shape == (2, 2)
    assert pale.shape == (0, 2)


def test_load_gt_with_pale_list(tmp_path):
    import json
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"image": "x.tif", "points": [[1, 2]], "pale": [[9, 9]]}))
    _, pts, pale = score.load_gt(str(p))
    assert pts.shape == (1, 2) and pale.shape == (1, 2)


def test_inside_frame_drops_points_outside():
    """11-14 % of every GT file sits outside the triple frame (measured
    2026-09-02). Those cells are correctly excluded from the count, so they
    must be excluded from the ground truth too, or recall reads as a
    collapse that never happened."""
    frame = {"x0": 100, "x1": 200, "y0": 50, "y1": 150}
    pts = np.array([[10.0, 10.0], [150.0, 100.0], [100.0, 50.0], [200.0, 100.0]])
    kept = score.inside_frame(pts, frame)
    # half-open: the top-left corner is in, the right edge is out
    assert kept.tolist() == [[150.0, 100.0], [100.0, 50.0]]


def test_inside_frame_without_a_frame_keeps_everything():
    pts = np.array([[10.0, 10.0], [20.0, 20.0]])
    assert score.inside_frame(pts, None).shape == (2, 2)


def test_inside_frame_handles_an_empty_set():
    assert score.inside_frame(np.zeros((0, 2)), {"x0": 0, "x1": 9, "y0": 0, "y1": 9}).shape == (0, 2)


def test_main_skips_gt_without_points(tmp_path, monkeypatch, capsys):
    """cluster_gt.json ({"chunks": [...]}) lives in the GT dir and must not crash the ruler."""
    import json, sys
    (tmp_path / "cluster_gt.json").write_text(json.dumps({"chunks": []}))
    monkeypatch.setattr(sys, "argv", ["score.py", "--gt", str(tmp_path), "--tif", str(tmp_path)])
    score.main()
    assert "no ground truth found" in capsys.readouterr().out


def test_dump_candidates_writes_outside_gt_never_into_it(tmp_path, monkeypatch, capsys):
    """--dump-candidates must land in --candidates-dir (default data/candidates/),
    never in data/gt/: data/gt is the ruler and generated files must not live
    in it (audit-backend #19)."""
    import json, sys

    gt_dir = tmp_path / "gt"
    tif_dir = tmp_path / "tif"
    cand_dir = tmp_path / "candidates"
    gt_dir.mkdir()
    tif_dir.mkdir()

    (gt_dir / "x.json").write_text(json.dumps({"image": "x.tif", "points": [[1.0, 1.0]]}))
    (tif_dir / "x.tif").write_bytes(b"not a real tif")  # never decoded, imread is mocked

    monkeypatch.setattr(score.cv2, "imread", lambda *a, **k: np.zeros((10, 10, 3), np.uint8))
    monkeypatch.setattr(score, "count_cells", lambda bgr, params: {
        "centers": [[1.0, 1.0], [5.0, 5.0]],   # [5,5] is an unmatched extra -> candidate
        "frame": None,
    })

    monkeypatch.setattr(sys, "argv", [
        "score.py", "--gt", str(gt_dir), "--tif", str(tif_dir),
        "--dump-candidates", "--candidates-dir", str(cand_dir),
    ])
    gt_files_before = sorted(p.name for p in gt_dir.iterdir())
    score.main()
    capsys.readouterr()

    assert sorted(p.name for p in gt_dir.iterdir()) == gt_files_before, \
        "data/gt/ (the ruler) must not gain, lose, or change any file"
    assert (cand_dir / "x.candidates.json").exists()
    with open(cand_dir / "x.candidates.json") as f:
        out = json.load(f)
    assert out["pale"] == [[5.0, 5.0]]


def test_16bit_input_stretched_not_truncated(tmp_path):
    """Verify that 16-bit input (e.g., 12-bit EVOS data) is stretched to 8-bit range,
    not truncated to the high byte. If decode_image used IMREAD_COLOR instead of
    IMREAD_UNCHANGED, uint16 data would lose 4 stops of contrast (12-bit 0-4095
    becomes almost black when only the high byte survives)."""
    import cv2
    from imaging import decode_image

    # Create a synthetic 16-bit single-channel image: background ~1000, blobs ~3000.
    # This 12-bit-like range (0-4095) would read as almost black if only the
    # high byte (0-15) is kept.
    img_16 = np.zeros((100, 100), dtype=np.uint16)
    img_16[:, :] = 1000  # background
    img_16[20:30, 20:30] = 3000  # bright blob
    img_16[70:80, 70:80] = 3000  # bright blob

    # Save it as a TIF file.
    img_path = str(tmp_path / "test_16bit.tif")
    cv2.imwrite(img_path, img_16)

    # Decode using imaging.decode_image, which is used by both app.py and score.py.
    bgr = decode_image(img_path)
    assert bgr is not None, "decode_image failed"
    assert bgr.dtype == np.uint8, f"decode_image should return uint8, got {bgr.dtype}"
    assert bgr.ndim == 3, f"decode_image should return BGR (3D), got ndim={bgr.ndim}"

    # Verify the background is near the bottom of the 8-bit range.
    bg_val = bgr[0, 0, 0]  # Any pixel in the untouched background area
    assert bg_val < 100, f"Background should be stretched low (0-100), got {bg_val}"

    # Verify the blobs are near the top of the 8-bit range.
    blob_val = bgr[25, 25, 0]  # Pixel inside the bright blob
    assert blob_val > 150, f"Blob should be stretched high (>150), got {blob_val}"

    # Verify the contrast is preserved: blob is clearly brighter than background.
    assert blob_val - bg_val > 100, \
        f"Contrast loss: blob {blob_val} - background {bg_val} = " \
        f"{blob_val - bg_val}, should be >100"
