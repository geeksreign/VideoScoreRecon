"""
B 站视频信息/播放地址嗅探 API 封装
"""

import re
from urllib.parse import parse_qs, urlparse

import requests

API_VIEW = "https://api.bilibili.com/x/web-interface/view"
API_PLAYURL = "https://api.bilibili.com/x/player/playurl"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://www.bilibili.com/",
}


def _headers(cookie=None):
    """构造请求头；提供 SESSDATA 时附带登录 Cookie 以解锁更高画质"""
    headers = dict(DEFAULT_HEADERS)
    if cookie:
        headers["Cookie"] = f"SESSDATA={cookie}"
    return headers


def parse_url(url):
    """
    从 B 站视频 URL 提取 (bvid, p)

    Args:
        url: 形如 https://www.bilibili.com/video/BV.../?...&p=2

    Returns:
        (bvid, page)
    """
    m = re.search(r"/video/(BV[0-9A-Za-z]+)", url)
    if not m:
        raise ValueError(f"无法从 URL 解析 bvid: {url}")
    bvid = m.group(1)
    q = parse_qs(urlparse(url).query)
    page = int(q.get("p", ["1"])[0])
    return bvid, page


def _get_json(url, params, cookie=None):
    resp = requests.get(url, params=params, headers=_headers(cookie), timeout=20)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(
            f"API 错误 ({url}): code={data.get('code')} msg={data.get('message')}"
        )
    return data["data"]


def get_video_info(bvid, page=1, cookie=None):
    """
    获取视频信息，返回选中分P的标题/cid 等

    Returns:
        {bvid, aid, title, page, part, cid, duration}
    """
    data = _get_json(API_VIEW, {"bvid": bvid}, cookie)
    pages = data.get("pages") or []
    if pages:
        target = next((pg for pg in pages if pg.get("page") == page), None)
        if target is None:
            raise ValueError(
                f"bvid={bvid} 没有分P {page}（共 {len(pages)} 个分P）"
            )
        return {
            "bvid": bvid,
            "aid": data.get("aid"),
            "title": data.get("title"),
            "page": page,
            "part": target.get("part"),
            "cid": target.get("cid"),
            "duration": target.get("duration"),
        }
    return {
        "bvid": bvid,
        "aid": data.get("aid"),
        "title": data.get("title"),
        "page": 1,
        "part": data.get("title"),
        "cid": data.get("cid"),
        "duration": data.get("duration"),
    }


def get_playurl(bvid, cid, qn=64, cookie=None):
    """
    获取 DASH 播放地址

    Returns:
        {quality, accept_quality, video: [...], audio: [...]}
    """
    params = {
        "bvid": bvid,
        "cid": cid,
        "qn": qn,       # 目标画质（未登录时以实际返回为准）
        "fnval": 16,    # DASH 格式
        "fnver": 0,
        "fourk": 1,
    }
    data = _get_json(API_PLAYURL, params, cookie)
    dash = data.get("dash")
    if not dash:
        raise RuntimeError("该视频没有 DASH 流（可能需要登录或视频不可下载）")
    return {
        "quality": data.get("quality"),
        "accept_quality": data.get("accept_quality", []),
        "video": dash.get("video", []),
        "audio": dash.get("audio", []),
    }


def pick_streams(dash):
    """
    挑选最高质量的视频流与音频流

    视频流优先 AVC（兼容性更好），其次选 id 最大的。
    """
    videos = dash["video"]
    if not videos:
        raise RuntimeError("DASH 流中没有视频")
    avc = [v for v in videos if v.get("codecs", "").startswith("avc")]
    pool = avc or videos
    video = max(pool, key=lambda v: v.get("id", 0))
    audio = None
    if dash.get("audio"):
        audio = max(dash["audio"], key=lambda a: a.get("id", 0))
    return video, audio


def sanitize_filename(name):
    """净化成合法文件名（替换非法字符与控制字符）"""
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", str(name))
    name = name.strip().strip(".")
    return name or "video"
