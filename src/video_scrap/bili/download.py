"""
B 站视频分片下载 + ffmpeg 本地拼接
"""

import shutil
import subprocess
from pathlib import Path

import imageio_ffmpeg
import requests

from api import (_headers, get_playurl, get_video_info, parse_url, pick_streams)


def download_file(urls, out_path, headers, chunk_size=1024 * 256, on_frac=None):
    """
    流式下载文件，按序尝试多个源（baseUrl -> backupUrl）

    on_frac(frac)：可选，下载进度回调（0~1），仅当响应带 Content-Length 时生效
    """
    out_path = Path(out_path)
    last_err = None
    for u in urls:
        try:
            with requests.get(u, headers=headers, stream=True, timeout=60) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length") or 0)
                done = 0
                with open(out_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=chunk_size):
                        if chunk:
                            f.write(chunk)
                            done += len(chunk)
                            if on_frac and total:
                                on_frac(min(1.0, done / total))
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"所有下载源均失败: {last_err}")


def remux(video_m4s, audio_m4s, out_mp4):
    """用 imageio-ffmpeg 自带 ffmpeg 把视频+音频 m4s 混流成 mp4"""
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-y",
        "-i", str(video_m4s),
        "-i", str(audio_m4s),
        "-c", "copy",
        "-movflags", "+faststart",
        str(out_mp4),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 混流失败:\n{proc.stderr[-2000:]}")


def download_bili_video(url, out_path, cookie=None, qn=64, on_progress=None, info=None):
    """
    下载 B 站视频（DASH 分片）到本地 mp4

    Args:
        url: B 站视频 URL
        out_path: 输出 mp4 路径
        cookie: SESSDATA 登录 Cookie（可选）
        qn: 请求画质
        on_progress: 可选回调 on_progress(progress 0~1, message)
        info: 可选，调用方已通过 get_video_info 获取的视频信息（避免重复请求）

    Returns:
        元数据 dict
    """
    bvid, page = parse_url(url)
    if info is None:
        info = get_video_info(bvid, page, cookie)
    dash = get_playurl(bvid, info["cid"], qn, cookie)
    video, audio = pick_streams(dash)

    headers = _headers(cookie)
    v_urls = [video["baseUrl"]] + video.get("backupUrl", [])
    a_urls = [audio["baseUrl"]] + audio.get("backupUrl", []) if audio else []

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    workdir = out_path.parent / "_bili_tmp"
    workdir.mkdir(parents=True, exist_ok=True)
    v_tmp = workdir / "video.m4s"
    a_tmp = workdir / "audio.m4s"
    try:
        print(f"下载视频流: {video.get('width')}x{video.get('height')} {video.get('codecs')}")
        if on_progress:
            on_progress(0.0, "下载视频流")
        download_file(v_urls, v_tmp, headers,
                      on_frac=lambda f: on_progress(f * 0.8, "下载视频流") if on_progress else None)
        if audio:
            print(f"下载音频流: {audio.get('codecs')}")
            if on_progress:
                on_progress(0.8, "下载音频流")
            download_file(a_urls, a_tmp, headers,
                          on_frac=lambda f: on_progress(0.8 + f * 0.2, "下载音频流") if on_progress else None)
        if audio:
            if on_progress:
                on_progress(1.0, "混流中")
            remux(v_tmp, a_tmp, out_path)
        else:
            v_tmp.replace(out_path)  # 无音频（少见）
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return {
        "url": url,
        "bvid": bvid,
        "page": page,
        "title": info["title"],
        "part": info["part"],
        "quality": dash["quality"],
        "codecs": video.get("codecs"),
        "width": video.get("width"),
        "height": video.get("height"),
        "duration": info["duration"],
        "path": str(out_path),
    }
