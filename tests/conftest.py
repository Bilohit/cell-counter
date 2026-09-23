"""Shared test setup.

Tests address captures as data/tif/... and data/gt/... relative to the repo
root, so the run is pinned there whatever directory pytest was started from.

data/ holds the maintainer's annotated captures and is not published. Tests
marked `data` need it and are skipped, not failed, on a checkout without it.
"""
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

HAVE_DATA = os.path.isdir("data/tif") and os.path.isdir("data/gt")


def pytest_collection_modifyitems(config, items):
    if HAVE_DATA:
        return
    skip = pytest.mark.skip(reason="needs the annotated captures in data/ (not published)")
    for item in items:
        if item.get_closest_marker("data"):
            item.add_marker(skip)
