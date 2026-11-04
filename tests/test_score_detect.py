"""find_score_rect：四边形内容校验（拒绝非乐谱白色区域误检）+ 回退白带"""

import cv2
import numpy as np

from score_detect import _looks_like_score, find_score_rect

W, H = 852, 480
BG = 60        # 暗背景
WHITE = 230
BLACK = 20


def _canvas():
    return np.full((H, W, 3), BG, dtype=np.uint8)


def _draw_white_block(img, x1, y1, x2, y2):
    img[y1:y2, x1:x2] = WHITE


def _draw_bottom_band(img, y=320):
    """全宽白色带（find_paper_band 可命中的典型乐谱白带）"""
    img[y:H, 0:W] = WHITE


def test_looks_like_score_thresholds():
    gray = np.full((300, 800), 230, dtype=np.uint8)
    # 正常乐谱典型暗占比（~3%）
    gray[100:110, :] = 0
    assert _looks_like_score(gray, 0, 0, 800, 300)
    # 密集内容（>15%）→ 拒绝
    gray = np.full((300, 800), 230, dtype=np.uint8)
    gray[0:60, :] = 0
    assert not _looks_like_score(gray, 0, 0, 800, 300)
    # 纯空白（0%）→ 拒绝
    gray = np.full((300, 800), 230, dtype=np.uint8)
    assert not _looks_like_score(gray, 0, 0, 800, 300)
    # 空区域 → 拒绝
    assert not _looks_like_score(gray, 0, 0, 0, 0)


def test_fake_quad_rejected_falls_back_to_band():
    """回归：上部密集内容白色四边形（暗占比 42% 实例）应被拒，回退底部白带"""
    img = _canvas()
    # 上部伪四边形：白色块 + 密集黑色斑块（暗占比 >15%），白斑块间白色保持连通
    _draw_white_block(img, 28, 0, 728, 314)
    for row in range(10, 300, 55):
        for col in range(40, 700, 85):
            img[row:row + 35, col:col + 55] = BLACK
    _draw_bottom_band(img)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    dark = (gray[0:314, 28:728] < 150).mean()
    assert dark > 0.15, f"测试图暗占比应超标: {dark:.1%}"
    assert not _looks_like_score(gray, 28, 0, 700, 314)

    rect = find_score_rect(img)
    assert rect is not None
    # 应返回底部白带，而非上部伪四边形
    assert rect[1] >= 300, f"应选中底部白带，实际 rect={rect}"


def test_real_score_quad_passes():
    """上部白色四边形内含典型乐谱暗占比（~3%）→ 主路径通过"""
    img = _canvas()
    _draw_white_block(img, 28, 0, 824, 314)
    # 模拟谱线：贯穿黑线（2px 高，闭运算可桥接，外轮廓保持四边形）
    for y in range(40, 300, 50):
        img[y:y + 2, 30:820] = BLACK

    rect = find_score_rect(img)
    assert rect is not None
    x1, y1, x2, y2 = rect
    assert y1 <= 6 and y2 <= 320, f"应选中上部四边形，实际 rect={rect}"
    assert x1 <= 30 and x2 >= 820


def test_blank_white_block_rejected():
    """纯空白白色块（暗占比 0）不是乐谱 → 回退白带"""
    img = _canvas()
    _draw_white_block(img, 28, 0, 728, 314)
    _draw_bottom_band(img)

    rect = find_score_rect(img)
    assert rect is not None
    assert rect[1] >= 300, f"纯白块应被拒，实际 rect={rect}"


def test_no_white_returns_none():
    img = np.full((H, W, 3), 100, dtype=np.uint8)
    assert find_score_rect(img) is None


def test_multiple_candidates_pick_valid_largest():
    """多个候选：最大的不合格 → 顺位取下一个合格候选"""
    img = _canvas()
    # 最大候选（上部，密集黑内容）→ 应被拒
    _draw_white_block(img, 28, 0, 728, 314)
    for row in range(10, 300, 55):
        for col in range(40, 700, 85):
            img[row:row + 35, col:col + 55] = BLACK
    # 次候选（下部 y>312，正常乐谱暗占比）→ 应被选中
    _draw_white_block(img, 400, 340, 840, 460)
    for y in range(350, 450, 25):
        img[y:y + 2, 405:835] = BLACK

    rect = find_score_rect(img)
    assert rect is not None
    assert rect[1] >= 330, f"应选中下部合格候选，实际 rect={rect}"
