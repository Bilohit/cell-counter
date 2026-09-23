"""Pins the bundle-stratified reporting formula (task C5, 2026-09-19): the
fold-level mean is the unweighted mean over folds of each fold's mean
per-tile |count error|, and its sd is the sample sd (ddof=1) over those
per-fold means. tools/fold_spread.py and ml/loo.py's fmt() both read this off
ml.data.fold_level_mean_sd, so a drift in either would show up here.

Pure-python: hand-built fake per-fold results, no training, no torch model
run (importing ml.loo pulls in ml.train, which imports torch, but nothing
here trains or scores an actual model).
"""
import numpy as np
import pytest

from ml import data, loo


def test_fold_level_mean_sd_hand_built():
    # 3 folds: [1, 3] mean 2; [4] mean 4; [5, 5, 7] mean 17/3
    errs_by_fold = {"a": [1.0, 3.0], "b": [4.0], "c": [5.0, 5.0, 7.0]}
    mean, sd = data.fold_level_mean_sd(errs_by_fold)
    assert mean == pytest.approx(35.0 / 9.0)          # (2 + 4 + 17/3) / 3
    assert sd == pytest.approx(np.sqrt(91.0 / 27.0))   # sample sd, ddof=1


def test_fold_level_mean_sd_single_fold_sd_is_nan():
    mean, sd = data.fold_level_mean_sd({"only": [1.0, 2.0, 3.0]})
    assert mean == pytest.approx(2.0)
    assert np.isnan(sd)


def test_fmt_reports_pooled_and_fold_level_distinctly():
    # Fake score_tile()-shaped rows: (name, (gt, det, tp, fp, fn, err%)).
    # gt/det/tp/fp/fn are arbitrary here; only the trailing err feeds the
    # per-tile error ladder and the fold-level stat under test. Names are
    # picked so data.group_of buckets them into 3 folds with the exact same
    # per-fold errors as test_fold_level_mean_sd_hand_built.
    rows = [
        ("picture 1 a", (10, 11, 9, 2, 1, 1.0)),
        ("picture 1 b", (10, 7, 6, 1, 4, -3.0)),
        ("picture 2 a", (10, 14, 8, 6, 2, 4.0)),
        ("picture 3 a", (10, 15, 8, 7, 2, 5.0)),
        ("picture 3 b", (10, 15, 8, 7, 2, 5.0)),
        ("picture 3 c", (10, 17, 8, 9, 2, 7.0)),
    ]
    assert [data.group_of(n) for n, _ in rows] == [
        "picture 1", "picture 1", "picture 2", "picture 3", "picture 3", "picture 3"]

    text, f1, worst = loo.fmt(rows, "unit test label")

    # Pooled mean |err| is unchanged: plain mean of all 6 |err| values.
    pooled = np.mean([1.0, 3.0, 4.0, 5.0, 5.0, 7.0])
    assert f"mean |err| {pooled:.2f} %" in text

    # Fold-level mean/sd must be the SAME numbers as the hand-built test above
    # (same fold contents), and must appear labelled distinctly from pooled.
    fold_mean, fold_sd = data.fold_level_mean_sd(
        {"picture 1": [1.0, 3.0], "picture 2": [4.0], "picture 3": [5.0, 5.0, 7.0]})
    assert fold_mean == pytest.approx(35.0 / 9.0)
    assert f"bundle-fold mean {fold_mean:.2f} % sd {fold_sd:.2f}" in text
    assert "pooled-over-tiles" in text
    # Sanity: pooled and fold-level read differently here (that's the whole point).
    assert f"{pooled:.2f}" != f"{fold_mean:.2f}"
