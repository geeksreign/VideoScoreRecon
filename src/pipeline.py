"""
Pipeline 共享编排：URL 下载 + 抽帧裁剪去重拼接 + 进度回调

CLI（src/main.py）与本地服务（src/server/）共用此模块。
"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
sys.path.insert(0, str(SRC / "videocore"))
sys.path.insert(0, str(SRC / "video_scrap" / "bili"))

from video_io import extract_and_crop  # noqa: E402


def _parse_time(s):
    """
    把时间字符串解析为秒

    支持纯秒数（如 "90"、"1.5"）或 mm:ss / hh:mm:ss（如 "1:30"、"1:02:30"）。
    """
    s = str(s).strip()
    if ':' in s:
        parts = [float(p) for p in s.split(':')]
        if len(parts) == 2:
            m, sec = parts
            return m * 60 + sec
        if len(parts) == 3:
            h, m, sec = parts
            return h * 3600 + m * 60 + sec
        raise ValueError(f"无法解析时间: {s}")
    return float(s)


def _download_from_url(url, data_dir, cookie=None, on_progress=None):
    """
    把 B 站视频 URL 下载为本地 mp4，放到 <data_dir>/<分P标题>/video/ 下

    on_progress(progress, message)：progress 为 0~1

    Returns:
        (本地 mp4 路径, 视频信息 dict)
    """
    import api
    import download

    bvid, page = api.parse_url(url)
    info = api.get_video_info(bvid, page, cookie)
    name = api.sanitize_filename(info["part"] or info["title"])
    video_dir = Path(data_dir) / name / "video"
    video_dir.mkdir(parents=True, exist_ok=True)
    out = video_dir / f"{name}.mp4"

    if out.exists():
        print(f"[提示] 视频已存在，跳过下载: {out}")
        return str(out), info

    if on_progress:
        on_progress(0.0, f"下载视频: {info['part']}")
    result = download.download_bili_video(url, out, cookie=cookie, on_progress=on_progress)
    print(f"下载完成: {result['title']} / {result['part']} "
          f"({result['width']}x{result['height']}) -> {out}")
    return str(out), info


def run_pipeline(video_input, data_dir, interval_sec=2, dedup_threshold=0.01,
                 stitch=True, start_time=None, end_time=None, cookie=None,
                 on_progress=None):
    """
    编排整个流程：URL 先下载，再抽帧/裁剪/去重/拼接。

    on_progress(stage, progress, message)：
        stage ∈ {download, extract, stitch, done}，progress 为 0~1

    Returns:
        metadata dict（含 saved / result_path 等）
    """
    def report(stage, progress, message=""):
        if on_progress:
            on_progress(stage, progress, message)

    video_path = str(video_input)
    info = None
    if video_path.startswith(('http://', 'https://')):
        report("download", 0.0, "解析视频信息")
        video_path, info = _download_from_url(
            video_path, data_dir, cookie,
            on_progress=lambda p, m: report("download", p, m))

    saved = extract_and_crop(
        video_path=video_path, data_dir=data_dir,
        interval_sec=interval_sec, dedup_threshold=dedup_threshold,
        stitch=stitch, start_time=start_time, end_time=end_time,
        on_progress=lambda stage, p, m: report(stage, p, m),
    )

    stem = Path(video_path).stem
    base = Path(data_dir) / stem
    result = {
        "video": video_path,
        "stem": stem,
        "saved": saved,
        "crops_dir": str(base / "crops"),
        "clusters_dir": str(base / "clusters"),
        "result_path": str(base / "final" / "res.jpg"),
    }
    if info:
        result.update({"title": info.get("title"), "part": info.get("part")})
    return result
