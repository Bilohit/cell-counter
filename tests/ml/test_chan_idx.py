"""chan_idx must keep the historical letters working - every run in loo.md is
labelled with one, and the shipped manifest says "channels": "C" - while also
naming the subsets the letters cannot express.

The letters are nested prefixes (A=[0], B=[0,1], C=[0,1,2]), so 4 of the 7
non-empty subsets of the 3 input channels have never been testable. Channel 0 is
the background-subtracted grayscale, 1 the grid line mask, 2 the ring-template
NCC response; 1 and 2 are classical pipeline outputs, which is what makes the
detector a hybrid and makes "is C the right subset" a real question.
"""
import pytest

from ml.data import chan_idx


def test_legacy_letters_unchanged():
    # the shipped weights are "channels": "C"; if this moves, inference breaks
    assert chan_idx("A") == [0]
    assert chan_idx("B") == [0, 1]
    assert chan_idx("C") == [0, 1, 2]


def test_digit_strings_name_arbitrary_subsets():
    assert chan_idx("0") == [0]
    assert chan_idx("02") == [0, 2]
    assert chan_idx("12") == [1, 2]
    assert chan_idx("2") == [2]


def test_digits_are_sorted_and_deduplicated():
    # the channel order is the tensor's channel order, so it must not depend on
    # how the flag was typed
    assert chan_idx("20") == [0, 2]
    assert chan_idx("002") == [0, 2]


def test_rejects_out_of_range_and_garbage():
    for bad in ("3", "0x", "", "D"):
        with pytest.raises((KeyError, ValueError)):
            chan_idx(bad)


def test_infer_channel_names_agree_with_chan_idx():
    """ml.infer keeps its own channel map so it can stay importable with only
    onnxruntime. If the two drift, a model trained on one channel set gets fed
    another and scores silently wrong instead of raising - so pin them together.
    """
    from ml.infer import chan_names, _CHAN_ORDER

    for spec in ("A", "B", "C", "0", "2", "02", "12", "20", "002"):
        assert chan_names(spec) == [_CHAN_ORDER[i] for i in chan_idx(spec)], spec


def test_infer_channel_names_reject_garbage():
    from ml.infer import chan_names

    for bad in ("3", "0x", "", "D"):
        with pytest.raises((KeyError, ValueError)):
            chan_names(bad)
