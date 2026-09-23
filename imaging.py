"""Shared image decode helpers used by both app.py and score.py.

One implementation so the live app and the scoring oracle can never decode
the same bytes differently (audit-backend.md #9).
"""
import cv2
import numpy as np


def stretch(im, rng=None):
    """Deep input -> 8-bit BGR. uint8 stays byte-identical; only the range moves.

    rng: the (lo, hi) input range to map onto 0-255. None means this image's
    own range.
    """
    if im.dtype != np.uint8:
        # Scale by the actual data range, not by the container width: a 12-bit
        # camera in a 16-bit TIF would otherwise lose 4 stops of contrast.
        f = im.astype(np.float32)
        lo, hi = (float(f.min()), float(f.max())) if rng is None else rng
        im = (np.zeros(f.shape, np.uint8) if hi <= lo
              else np.clip((f - lo) * (255.0 / (hi - lo)), 0, 255).astype(np.uint8))
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    return im


def decode_image(path):
    """Load and convert a TIF/PNG/JPG to 8-bit BGR, preserving full depth.

    Uses IMREAD_UNCHANGED + stretch, not IMREAD_COLOR: a 16-bit TIF read as
    IMREAD_COLOR keeps only the high byte, so 12-bit EVOS data (0-4095) would
    arrive almost black (0-15 in uint8). The current corpus is all 8-bit, where
    the two decodes are byte-for-byte identical; this matters for future 16-bit
    input (audit-backend.md #9).
    """
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        return None
    if raw.ndim == 3 and raw.shape[2] == 4:
        raw = cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)
    return stretch(raw)
