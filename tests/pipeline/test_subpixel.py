"""The count must not move when refinement is on.

Refinement runs after every gate and after per_square_counts, so this is
structural rather than empirical - but edge_margin and the triple frame are both
half-open tests on x and y, and a 0.5 px shift applied in the wrong place would
silently move a marker across one of them. That is exactly the bug this pins:
the test fails if anyone moves the refine() call earlier in count_cells.
"""
import glob

import cv2
import pytest

import pipeline


def a_tile():
    for pat in ("data/tif/10x tile*.tif", "data/tif/*.tif"):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[0]
    return None


@pytest.fixture(scope="module")
def bgr():
    path = a_tile()
    if path is None:
        pytest.skip("no capture in data/tif")
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        pytest.skip(f"unreadable: {path}")
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


@pytest.fixture
def restore():
    was = pipeline.SUBPIXEL
    yield
    pipeline.SUBPIXEL = was


@pytest.mark.parametrize("level", [2, 3])
def test_count_identical_with_and_without_subpixel(bgr, restore, level):
    pipeline.SUBPIXEL = False
    off = pipeline.count_cells(bgr, {"level": level})
    pipeline.SUBPIXEL = True
    on = pipeline.count_cells(bgr, {"level": level})

    assert on["count"] == off["count"]
    assert len(on["centers"]) == len(off["centers"])
    assert on["squares"] == off["squares"]
    for (ax, ay), (bx, by) in zip(off["centers"], on["centers"]):
        assert abs(ax - bx) <= 0.5 and abs(ay - by) <= 0.5


def test_subpixel_actually_produces_fractional_coordinates(bgr, restore):
    pipeline.SUBPIXEL = True
    r = pipeline.count_cells(bgr, {"level": 3})
    frac = sum(1 for x, y in r["centers"] if x % 1 or y % 1)
    assert frac > 0.5 * len(r["centers"]), (
        f"only {frac}/{len(r['centers'])} markers moved - the heatmap is flatter "
        "than refinement can read, or refine() is not being reached")


def test_off_by_default_leaves_integer_coordinates(bgr):
    # the shipped default: nothing about the returned points changes
    assert pipeline.SUBPIXEL is False
    r = pipeline.count_cells(bgr, {"level": 3})
    assert all(isinstance(x, int) and isinstance(y, int) for x, y in r["centers"])
