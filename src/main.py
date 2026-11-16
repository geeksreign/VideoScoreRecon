"""
Pipeline CLI 入口

统一入口：把视频（本地路径、B 站或 YouTube URL）处理为曲谱裁剪与拼接结果。

用法:
    python src/main.py --video <路径或URL> [--data-dir data] [选项...]
"""

import argparse
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
sys.path.insert(0, str(SRC))

from pipeline import run_pipeline, _parse_time  # noqa: E402


def _time_arg(value):
    """argparse type：解析时间参数，非法输入转为用法提示而非裸 traceback"""
    try:
        return _parse_time(value)
    except (ValueError, TypeError) as e:
        raise argparse.ArgumentTypeError(
            f"无法解析时间 '{value}'（支持秒、mm:ss 或 hh:mm:ss）"
        ) from e


def main():
    REPO = SRC.parent
    DEFAULT_DATA = REPO / 'data'

    ap = argparse.ArgumentParser(description='从视频中抽取并裁剪曲谱区域（相邻帧去重+拼接）')
    ap.add_argument('--video', required=True, help='输入视频路径、B 站 URL 或 YouTube URL')
    ap.add_argument('--data-dir', default=str(DEFAULT_DATA), help='数据根目录（默认 <repo>/data）')
    ap.add_argument('--interval-sec', type=float, default=3, help='抽帧间隔秒数（默认 3）')
    ap.add_argument('--dedup-threshold', type=float, default=0.01, help='曲谱骨架差异占比阈值（默认 0.01=1%%）')
    ap.add_argument('--no-stitch', action='store_true', help='跳过最终拼接')
    ap.add_argument('--start-time', type=_time_arg, default=None, help='截取开始时间（秒或 mm:ss，默认视频开头）')
    ap.add_argument('--end-time', type=_time_arg, default=None, help='截取截止时间（秒或 mm:ss，默认视频结尾）')
    ap.add_argument('--cookie', default=None, help='B 站登录 Cookie（SESSDATA），仅 B 站 URL 时使用')
    args = ap.parse_args()

    try:
        run_pipeline(
            video_input=args.video,
            data_dir=args.data_dir,
            interval_sec=args.interval_sec,
            dedup_threshold=args.dedup_threshold,
            stitch=not args.no_stitch,
            start_time=args.start_time,
            end_time=args.end_time,
            cookie=args.cookie,
        )
    except Exception as e:  # noqa: BLE001
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
