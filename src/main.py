"""
Pipeline CLI 入口

统一入口：把视频（本地路径或 B 站 URL）处理为曲谱裁剪与拼接结果。

用法:
    python src/main.py --video <路径或URL> [--data-dir data] [选项...]
"""

import argparse
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
sys.path.insert(0, str(SRC))

from pipeline import run_pipeline, _parse_time  # noqa: E402


def main():
    REPO = SRC.parent
    DEFAULT_DATA = REPO / 'data'
    DEFAULT_VIDEO = DEFAULT_DATA / 'Gary Moore Style in A_哔哩哔哩_bilibili.mp4'

    ap = argparse.ArgumentParser(description='从视频中抽取并裁剪曲谱区域（相邻帧去重+拼接）')
    ap.add_argument('--video', default=str(DEFAULT_VIDEO), help='输入视频路径或 B 站 URL')
    ap.add_argument('--data-dir', default=str(DEFAULT_DATA), help='数据根目录（默认 <repo>/data）')
    ap.add_argument('--interval-sec', type=float, default=2, help='抽帧间隔秒数（默认 2）')
    ap.add_argument('--dedup-threshold', type=float, default=0.01, help='曲谱骨架差异占比阈值（默认 0.01=1%%）')
    ap.add_argument('--no-stitch', action='store_true', help='跳过最终拼接')
    ap.add_argument('--start-time', default=None, help='截取开始时间（秒或 mm:ss，默认视频开头）')
    ap.add_argument('--end-time', default=None, help='截取截止时间（秒或 mm:ss，默认视频结尾）')
    ap.add_argument('--cookie', default=None, help='B 站登录 Cookie（SESSDATA），仅 --video 为 URL 时使用')
    args = ap.parse_args()

    run_pipeline(
        video_input=args.video,
        data_dir=args.data_dir,
        interval_sec=args.interval_sec,
        dedup_threshold=args.dedup_threshold,
        stitch=not args.no_stitch,
        start_time=_parse_time(args.start_time) if args.start_time else None,
        end_time=_parse_time(args.end_time) if args.end_time else None,
        cookie=args.cookie,
    )


if __name__ == '__main__':
    main()
