"""_parse_time：秒 / mm:ss / hh:mm:ss 解析"""

import pytest

from pipeline import _parse_time


def test_plain_seconds():
    assert _parse_time("90") == 90
    assert _parse_time("1.5") == 1.5
    assert _parse_time(30) == 30


def test_mmss():
    assert _parse_time("1:30") == 90
    assert _parse_time("0:05") == 5


def test_hhmmss():
    assert _parse_time("1:02:30") == 3750
    assert _parse_time("0:00:01") == 1


@pytest.mark.parametrize("bad", ["abc", "", "1:2:3:4", "10:"])
def test_invalid_raises(bad):
    with pytest.raises((ValueError, TypeError)):
        _parse_time(bad)
