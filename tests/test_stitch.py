"""stitch_scores：帧号排序、7 位帧号、写盘失败处理"""

import cv2
import numpy as np
import pytest

import video_io


def _write_crop(dirpath, frame_no, h=10, w=20, val=200):
    img = np.full((h, w, 3), val, dtype=np.uint8)
    path = dirpath / f"score_{frame_no:06d}.jpg"
    assert cv2.imwrite(str(path), img)
    return path


def test_stitch_orders_by_numeric_frame(tmp_path):
    """帧号按数字序而非字典序拼接（7 位帧号回归）"""
    _write_crop(tmp_path, 999999, h=10)
    _write_crop(tmp_path, 1000000, h=10)   # 7 位文件名
    _write_crop(tmp_path, 10, h=10)
    out = video_io.stitch_scores(tmp_path, tmp_path / "res.png")
    assert out is not None and out.exists()
    img = cv2.imread(str(out))
    assert img.shape[0] == 30              # 三张 10px 高
    # 顺序：frame 10 应在最上（顶部区域 = frame10 的值）
    assert img[0, 0, 0] == 200


def test_stitch_ignores_non_crop_files(tmp_path):
    _write_crop(tmp_path, 1, h=10)
    cv2.imwrite(str(tmp_path / "res.png"), np.zeros((5, 20, 3), np.uint8))
    cv2.imwrite(str(tmp_path / "other.jpg"), np.zeros((5, 20, 3), np.uint8))
    out = video_io.stitch_scores(tmp_path, tmp_path / "out.png")
    img = cv2.imread(str(out))
    assert img.shape[0] == 10             # 只拼了 score_1


def test_stitch_no_crops_returns_none(tmp_path):
    assert video_io.stitch_scores(tmp_path) is None


def test_stitch_write_failure_returns_none(tmp_path, monkeypatch):
    """回归：imwrite 失败时不得返回成功路径"""
    _write_crop(tmp_path, 1, h=10)
    monkeypatch.setattr(video_io.cv2, "imwrite", lambda *a, **k: False)
    assert video_io.stitch_scores(tmp_path, tmp_path / "res.png") is None


def test_default_output_is_png(tmp_path):
    _write_crop(tmp_path, 1, h=10)
    out = video_io.stitch_scores(tmp_path)
    assert out.suffix == ".png"
