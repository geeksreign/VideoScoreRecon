"""bili api：URL 解析与 Cookie 归一化（不发起网络请求）"""

import pytest

from api import _headers, _normalize_cookie, parse_url


def test_parse_url_basic():
    assert parse_url("https://www.bilibili.com/video/BV1xx411c7mD") == ("BV1xx411c7mD", 1)


def test_parse_url_with_page_and_query():
    bvid, page = parse_url("https://www.bilibili.com/video/BV1xx411c7mD?p=2&vd_source=abc")
    assert bvid == "BV1xx411c7mD"
    assert page == 2


def test_parse_url_invalid():
    with pytest.raises(ValueError):
        parse_url("https://example.com/not-bilibili")


def test_normalize_cookie_bare_value():
    assert _normalize_cookie("abc123") == "SESSDATA=abc123"


def test_normalize_cookie_already_prefixed():
    """回归：不允许多重前缀 SESSDATA=SESSDATA=xxx"""
    assert _normalize_cookie("SESSDATA=abc123") == "SESSDATA=abc123"


def test_normalize_cookie_full_string():
    assert _normalize_cookie("SESSDATA=a; other=b") == "SESSDATA=a; other=b"


def test_normalize_cookie_blank():
    assert _normalize_cookie("") is None
    assert _normalize_cookie("   ") is None


def test_headers_with_and_without_cookie():
    assert "Cookie" not in _headers(None)
    assert "Cookie" not in _headers("")
    assert _headers("abc")["Cookie"] == "SESSDATA=abc"
    assert _headers("SESSDATA=abc")["Cookie"] == "SESSDATA=abc"
