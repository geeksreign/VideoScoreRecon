"""ytdlp 下载器：YouTube URL 识别与 pipeline 按源分流（不发起网络请求）"""

import pytest

import pipeline
from ytdlp import downloader as yd


@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", True),
    ("https://youtu.be/dQw4w9WgXcQ", True),
    ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", True),
    ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", True),
    ("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", True),
    ("https://www.bilibili.com/video/BV1xx411c7mD", False),
    ("https://example.com/video.mp4", False),
    ("local/path/video.mp4", False),
    ("/abs/path/video.mp4", False),
])
def test_is_youtube_url(url, expected):
    assert pipeline._is_youtube_url(url) is expected


def test_ffmpeg_location_points_to_imageio_binary():
    """回归：yt-dlp 合并必须能找到 ffmpeg（imageio-ffmpeg 自带的）"""
    import imageio_ffmpeg
    assert yd._ffmpeg_location() == imageio_ffmpeg.get_ffmpeg_exe()


class FakeYDL:
    """可注入的假 YoutubeDL：记录 opts，extract_info 返回预设结果（按实例序）"""

    last_opts = None
    results = {}
    counter = None

    def __init__(self, opts=None):
        self.opts = opts
        if FakeYDL.counter is None:
            FakeYDL.counter = 0
        self._id = FakeYDL.counter
        FakeYDL.counter += 1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=True):
        FakeYDL.last_opts = self.opts
        result = self.results.get(self._id)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def fake_ydl(monkeypatch):
    FakeYDL.results = {}
    FakeYDL.counter = 0
    monkeypatch.setattr(yd.yt_dlp, "YoutubeDL", FakeYDL)
    return FakeYDL


def test_fetch_info_uses_noplaylist(fake_ydl):
    """回归：watch?v=X&list=Y 预取不得展开整个播放列表"""
    fake_ydl.results = {0: {"title": "T"}}
    info = yd._fetch_info("https://www.youtube.com/watch?v=X&list=PLabc&index=3")
    assert info["title"] == "T"
    assert fake_ydl.last_opts.get("noplaylist") is True


def test_fetch_info_rejects_playlist(fake_ydl):
    fake_ydl.results = {0: {"_type": "playlist", "title": "PL"}}
    with pytest.raises(RuntimeError, match="暂不支持播放列表"):
        yd._fetch_info("https://www.youtube.com/playlist?list=PLabc")


def test_fetch_info_wraps_membership_error(fake_ydl):
    fake_ydl.results = {
        0: yd.yt_dlp.utils.DownloadError(
            "[youtube] CtCZFYv_kGQ: Join this channel to get access "
            "to members-only content like this video")
    }
    with pytest.raises(RuntimeError, match="会员专享"):
        yd._fetch_info("https://www.youtube.com/watch?v=CtCZFYv_kGQ")


def test_fetch_info_wraps_generic_download_error(fake_ydl):
    fake_ydl.results = {0: yd.yt_dlp.utils.DownloadError("[youtube] boom")}
    with pytest.raises(RuntimeError, match="YouTube 下载失败"):
        yd._fetch_info("https://www.youtube.com/watch?v=X")


@pytest.mark.parametrize("msg,keyword", [
    ("Join this channel to get access to members-only content", "会员专享"),
    ("[youtube] X: This video is unavailable", "YouTube 下载失败"),
])
def test_youtube_error_mapping(msg, keyword):
    err = yd._youtube_error("https://youtu.be/X", yd.yt_dlp.utils.DownloadError(msg))
    assert keyword in str(err)


def _patch_pipeline(monkeypatch, tmp_path):
    """打桩下载分支与裁剪入口，返回记录各分支调用次数的哨兵"""
    calls = {"yt": 0, "bili": 0, "extract": 0}

    def fake_youtube(url, data_dir, on_progress=None):
        calls["yt"] += 1
        return "/tmp/fake_youtube.mp4", {"title": "T", "part": "T"}

    def fake_bili(url, data_dir, cookie=None, on_progress=None):
        calls["bili"] += 1
        return "/tmp/fake_bili.mp4", {"title": "T", "part": "T"}

    def fake_extract(video_path, **kw):
        calls["extract"] += 1
        return {"ok": True}

    monkeypatch.setattr(pipeline, "_download_youtube", fake_youtube)
    monkeypatch.setattr(pipeline, "_download_from_url", fake_bili)
    monkeypatch.setattr(pipeline, "extract_and_crop", fake_extract)
    return calls


def test_run_pipeline_youtube_url(monkeypatch, tmp_path):
    calls = _patch_pipeline(monkeypatch, tmp_path)
    result = pipeline.run_pipeline(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        str(tmp_path))
    assert calls == {"yt": 1, "bili": 0, "extract": 1}
    assert result["stem"] == "fake_youtube"


def test_run_pipeline_bili_url(monkeypatch, tmp_path):
    calls = _patch_pipeline(monkeypatch, tmp_path)
    pipeline.run_pipeline("https://www.bilibili.com/video/BV1xx411c7mD",
                          str(tmp_path))
    assert calls == {"yt": 0, "bili": 1, "extract": 1}


def test_run_pipeline_local_path_skips_download(monkeypatch, tmp_path):
    calls = _patch_pipeline(monkeypatch, tmp_path)
    pipeline.run_pipeline("/tmp/some_local.mp4", str(tmp_path))
    assert calls == {"yt": 0, "bili": 0, "extract": 1}