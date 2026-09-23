"""The random square split must be a partition that never shares pixels.

leave-one-TILE-out was measured on 2026-09-12 to report better than the truth
because `.1` and `.2` are two shots of the same spot. The square split exists to
randomise across bundles WITHOUT reintroducing that leak, so the property worth
a test is exactly: no square is ever split across two folds.
"""
import random

import pytest

from ml import data


def _square_folds(k=5, seed=0):
    units = sorted({data.square_of(t) for t in data.TILES})
    random.Random(seed).shuffle(units)
    part = [set(units[i::k]) for i in range(k)]
    return [[t for t in data.TILES if data.square_of(t) in p] for p in part]


def test_square_keeps_overlapping_captures_together():
    assert data.square_of("hemo1 KA1 sq2.1") == data.square_of("hemo1 KA1 sq2.2")
    assert data.square_of("hemo1 KA1 sq2.1") != data.square_of("hemo1 KA1 sq3.1")
    # both halves of one slide capture stay together, as under group_of
    assert (data.square_of("10x tile picture 3; first three rows")
            == data.square_of("10x tile picture 3; last three rows"))


@pytest.mark.data
def test_held_out_tiles_are_excluded_from_training_samples():
    held = set(_square_folds()[0])
    stems = {s.get("stem", s.get("name")) for s in data.build_samples(held, "C")}
    assert not (held & {s for s in stems if s})
