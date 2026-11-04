"""dedup 核心：蓝色光标抹除、补白、对齐有效区、同异判定"""

import cv2
import numpy as np

from dedup import (
    ImageDedup,
    _align_by_translation,
    _extract_score_binary,
    _pad_to_common,
    _scores_same,
)


def _make_score(w=200, h=100, shift=(0, 0), fill=220, lines=5):
    """合成一张浅灰底 + 黑色谱线的曲谱图（可整体平移）"""
    img = np.full((h, w, 3), fill, dtype=np.uint8)
    dx, dy = shift
    for i in range(lines):
        y = 20 + i * 15 + dy
        if 0 <= y < h:
            img[y:y + 2, max(0, dx):min(w, w + dx)] = 0
    return img


def test_extract_removes_blue_cursor():
    img = _make_score()
    img[40:60, 50:55] = [255, 0, 0]  # 纯蓝光标
    bw = _extract_score_binary(img)
    # 蓝色区域被填成浅灰(>100) → 应为白背景
    assert np.all(bw[40:60, 50:55] == 255)
    # 黑色谱线保留
    assert np.any(bw == 0)


def test_pad_to_common():
    a = np.zeros((10, 20), dtype=np.uint8)
    b = np.zeros((30, 5), dtype=np.uint8)
    pa, pb = _pad_to_common(a, b)
    assert pa.shape == pb.shape == (30, 20)
    assert np.all(pa[10:, :] == 255)   # a 补白
    assert np.all(pb[:, 5:] == 255)    # b 补白


def test_valid_mask_not_empty_for_small_images():
    """小图 + 大位移时 valid_mask 不允许全空（回归批次1修复）"""
    ref = np.zeros((40, 60), dtype=np.uint8)
    ref[10:30, ::3] = 255
    mov = np.roll(ref, 20, axis=1)
    _, _, mask = _align_by_translation(ref, mov, max_shift=30)
    assert mask.any(), "valid_mask 不应全空"
    # 中心区必须参与比对
    assert mask[ref.shape[0] // 2, ref.shape[1] // 2]


def test_scores_same_identical():
    bw = _extract_score_binary(_make_score())
    same, ratio = _scores_same(bw, bw.copy(), 0.01)
    assert same
    assert ratio <= 0.01


def test_scores_same_tolerates_shift():
    bw1 = _extract_score_binary(_make_score())
    bw2 = _extract_score_binary(_make_score(shift=(8, 3)))
    same, _ = _scores_same(bw1, bw2, 0.01)
    assert same, "轻微平移应判定为同一谱面"


def test_scores_different_layout():
    bw1 = _extract_score_binary(_make_score(lines=5))
    bw2 = _extract_score_binary(_make_score(fill=60, lines=2))  # 灰底+不同内容
    same, ratio = _scores_same(bw1, bw2, 0.01)
    assert not same
    assert ratio > 0.01


def test_scores_different_sizes_are_padded_and_compared():
    """尺寸不同 → 补白后继续比对（与 comp_similar_pics 工具一致）"""
    bw1 = _extract_score_binary(_make_score(w=200, h=100))
    bw2 = _extract_score_binary(_make_score(w=120, h=60))
    same, ratio = _scores_same(bw1, bw2, 0.01)
    assert not same
    assert 0 < ratio <= 1.0  # 有有效区可比，而非直接 1.0 兜底


def test_imagededup_repeat_and_change():
    d = ImageDedup(threshold=0.01)
    img = _make_score()
    is_new1, c1 = d.add(img)
    is_new2, c2 = d.add(img.copy())
    is_new3, c3 = d.add(_make_score(fill=30, lines=3))
    assert is_new1 and not is_new2 and is_new3
    assert c1 == c2          # 重复帧属于同一段
    assert c3 != c1          # 内容变化开新段
    assert d.count == 2
