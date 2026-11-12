"""
YouTube 视频下载（基于 yt-dlp）

与 B 站点下载器（../bili）的对外契约一致：
- 输出 mp4 到 <data>/<标题>/video/<标题>.mp4
- 返回 {title, part, width, height, duration, path} 元数据 dict
- on_progress(progress 0~1, message) 进度回调
"""

import json
import sys
from pathlib import Path

import imageio_ffmpeg

try:
    import yt_dlp
    from yt_dlp.utils import sanitize_filename
except ImportError:
    raise SystemExit("缺少依赖 yt-dlp，请先执行：uv add yt-dlp")


def _ffmpeg_location():
    """复用 imageio-ffmpeg 自带的 ffmpeg（供 yt-dlp 合并音视频用）

    返回二进制完整路径（而非所在目录）：imageio 的二进制名为
    ffmpeg-<平台>-v<版本>，yt-dlp 在目录内只认 ffmpeg/avconv 等固定名字。
    """
    return imageio_ffmpeg.get_ffmpeg_exe()


def _youtube_error(url, e):
    """把 yt-dlp 的 DownloadError 转成干净的中文 RuntimeError

    播放列表处理不在这里判断（_fetch_info 通过 _type 精准识别），
    避免对 DownloadError 文案里的 "playlist" 字样误伤单个视频下载。
    """
    msg = str(e)
    if any(k in msg.lower() for k in (
        "join this channel", "members-only", "members only",
        "channel membership", "premium only",
    )):
        return RuntimeError(f"该视频为 YouTube 会员专享内容，无法匿名下载: {url}")
    return RuntimeError(f"YouTube 下载失败: {msg}")


def download_youtube_video(url, out_path, on_progress=None):
    """
    下载 YouTube 视频（最高画质，合并音视频为 mp4）到指定路径

    Args:
        url: YouTube 视频 URL（含 youtu.be 短链）
        out_path: 输出路径（模板，实际扩展名由 yt-dlp 决定，一般为 .mp4）
        on_progress: 可选回调 on_progress(progress 0~1, message)

    Returns:
        元数据 dict（title / part / width / height / duration / path 等）
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    def _hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                frac = min(1.0, d.get("downloaded_bytes", 0) / total)
                if on_progress:
                    on_progress(frac, f"下载 {frac * 100:.0f}%")
        elif d.get("status") == "finished":
            if on_progress:
                on_progress(0.99, "合并音视频中")

    ydl_opts = {
        # 优先 H.264 + mp4 容器（与 bili 分流器 pick_streams 的 AVC 优先一致，
        # 保证 OpenCV/imageio 可解码）；YouTube 最高一般给到 1080p
        "format": ("best[ext=mp4][vcodec*=avc1]"
                   "/[ext=mp4][vcodec*=avc1]-bestaudio[ext=m4a]"
                   "/bestvideo[ext=mp4][vcodec*=avc1]+bestaudio[ext=m4a]"
                   "/bv*+ba/b"),
        "merge_output_format": "mp4",
        "outtmpl": str(out_path.with_suffix(".%(ext)s")),
        "noplaylist": True,
        "noprogress": True,
        "quiet": True,
        "no_warnings": True,
        "ffmpeg_location": _ffmpeg_location(),
        "progress_hooks": [_hook],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as e:
            raise _youtube_error(url, e) from e

    if info is None or info.get("_type") == "playlist":
        raise RuntimeError(
            f"YouTube 下载失败（可能是播放列表或该视频不可下载）: {url}"
        )

    candidates = sorted(out_path.parent.glob(out_path.stem + ".*"))
    final = next((c for c in candidates if c.suffix == ".mp4"), None) or (
        candidates[0] if candidates else None
    )
    if final is None:
        raise RuntimeError(f"下载产物未生成: {out_path.with_suffix('.*')}")

    if final.suffix != ".mp4":
        mp4 = final.with_suffix(".mp4")
        final.rename(mp4)  # 容器级改名；ffmpeg 合并产物已保证 mp4，个别无音轨单流除外
        final = mp4

    return {
        "url": url,
        "title": info.get("title"),
        "part": info.get("title"),
        "width": info.get("width"),
        "height": info.get("height"),
        "duration": info.get("duration"),
        "ext": final.suffix.lstrip("."),
        "path": str(final),
    }


def _fetch_info(url):
    """
    预取单个视频信息（不做任何下载）

    - 必须 noplaylist：watch?v=X&list=Y 只解析 X，否则列表内失效/会员
      条目会中断整个流程
    - 纯播放列表链接直接拒绝（本工具一次只处理一个视频）
    """
    pre_opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(pre_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as e:
            raise _youtube_error(url, e) from e
    if info is None:
        raise RuntimeError(f"无法解析 YouTube 视频信息: {url}")
    if info.get("_type") == "playlist":
        raise RuntimeError(
            f"暂不支持播放列表，请打开列表中的单个视频链接: {url}")
    return info


def download_youtube_video_to_dir(url, video_dir, on_progress=None):
    """
    按视频标题把 YouTube 视频下载到 <video_dir>/<标题>.<ext>

    video_dir 即 <data_dir>/<标题>/video/，标题由 yt-dlp 返回的实际标题决定。

    Returns:
        (本地视频路径, 元数据 dict)
    """
    info = _fetch_info(url)

    title = sanitize_filename(info.get("title") or "video")
    video_dir = Path(video_dir) / title / "video"
    video_dir.mkdir(parents=True, exist_ok=True)
    out = video_dir / f"{title}.mp4"

    if out.exists():
        print(f"[提示] 视频已存在，跳过下载: {out}")
        return str(out), info

    meta = download_youtube_video(url, out, on_progress=on_progress)
    return meta["path"], {**info, **meta}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python downloader.py <url> <out.mp4>")
        sys.exit(1)
    result = download_youtube_video(sys.argv[1], sys.argv[2])
    print(json.dumps(result, ensure_ascii=False, indent=2))