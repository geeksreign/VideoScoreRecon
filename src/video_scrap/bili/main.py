"""
B 站视频下载 CLI

用法:
    python main.py <url> [-o out.mp4] [--cookie SESSDATA] [--qn 64] [--name 名称]

输出 JSON 元数据到 stdout，便于被 video_io.py 等脚本调用。
"""

import argparse
import json
import sys
from pathlib import Path

from api import get_video_info, parse_url, sanitize_filename
from download import download_bili_video


def main():
    ap = argparse.ArgumentParser(description="B站视频下载（DASH 分片 + ffmpeg 拼接）")
    ap.add_argument("url", help="B站视频 URL（支持分P参数 p）")
    ap.add_argument("-o", "--output", default=None, help="输出 mp4 路径（默认按分P标题命名到当前目录）")
    ap.add_argument("--cookie", default=None, help="登录 Cookie（SESSDATA），解锁更高画质")
    ap.add_argument("--qn", type=int, default=64, help="请求画质（默认 64=720P，未登录取实际可用最高）")
    ap.add_argument("--name", default=None, help="输出文件名（不含扩展名）")
    args = ap.parse_args()

    if args.output is None:
        bvid, page = parse_url(args.url)
        info = get_video_info(bvid, page, args.cookie)
        name = sanitize_filename(args.name or info["part"] or info["title"])
        out = Path.cwd() / f"{name}.mp4"
    else:
        out = Path(args.output)

    result = download_bili_video(args.url, out, cookie=args.cookie, qn=args.qn)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
