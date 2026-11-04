import cv2
import numpy as np
from pic_clip import refine_top_by_projection, find_paper_band


def _looks_like_score(gray, x, y, cw, ch, min_dark=0.002, max_dark=0.15):
    """
    乐谱内容合理性校验：候选区域内暗像素占比须落在乐谱典型区间

    白纸乐谱（阈值 200 二值化下的白块）实际暗像素（灰度 <150）占比很低
    （实测正常 crop 约 0.2%~4%）；非乐谱的白色大块（画面/字幕/转场）暗占比
    往往远超 15%（误检实例达 42%），据此拒绝纯几何误检。

    注意用原始候选框（不含 pad）计算：pad 圈在暗背景上会注入边框噪声，
    干扰占比判据。

    Args:
        gray: 灰度图
        x, y, cw, ch: 候选四边形的 boundingRect
        min_dark: 暗像素占比下限（排除纯空白块）
        max_dark: 暗像素占比上限（排除密集内容画面）

    Returns:
        True 表示区域内容像乐谱
    """
    region = gray[y:y + ch, x:x + cw]
    if region.size == 0:
        return False
    ratio = float(np.count_nonzero(region < 150)) / region.size
    return min_dark <= ratio <= max_dark


def _trim_trailing_dark(gray, rect, min_white=0.3):
    """
    修剪 rect 尾部的连续非白行

    白色乐谱块经闭运算后，轮廓可能因黑区中的稀疏亮斑被桥接而向下探入
    非乐谱的暗区（实测混入 6~28px 黑带）。从底向上修剪白占比 < min_white
    的连续行，直到遇到白行为止；只动尾部，不侵入谱面内容。

    Args:
        gray: 灰度图
        rect: (x1, y1, x2, y2)
        min_white: 行内近白像素占比下限（黑带行实测 ≤4%，乐谱纸行 ≥90%）

    Returns:
        修剪后的 rect；修剪后高度为 0 时返回 None
    """
    x1, y1, x2, y2 = rect
    white = (gray[y1:y2, x1:x2] > 200).mean(axis=1)
    while y2 - 1 >= y1 and white[y2 - 1 - y1] < min_white:
        y2 -= 1
    return (x1, y1, x2, y2) if y2 > y1 else None


def find_score_rect(img, thresh=200, min_w_ratio=0.5, min_h_ratio=0.08,
                    top_ratio=0.18, bottom_ratio=0.35, pad=6,
                    min_band_ratio=0.125):  # 调小了 top_ratio
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, thresh, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 5))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape
    candidates = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        approx = cv2.approxPolyDP(cnt, 0.02 * cv2.arcLength(cnt, True), True)
        if len(approx) != 4:
            continue
        if cw < w * min_w_ratio or ch < h * min_h_ratio:
            continue
        # 仅允许上方或下方
        if not (y < h * top_ratio or y > h * (1 - bottom_ratio)):
            continue
        candidates.append((x, y, cw, ch))

    # 按面积降序逐个做内容校验：几何像乐谱不代表内容是乐谱
    for x, y, cw, ch in sorted(candidates, key=lambda b: b[2] * b[3], reverse=True):
        if _looks_like_score(gray, x, y, cw, ch):
            rect = _trim_trailing_dark(gray, (
                max(0, x - pad), max(0, y - pad),
                min(w, x + cw + pad), min(h, y + ch + pad)))
            if rect is not None:
                return rect

    # 无合格四边形候选（或全部被内容校验拒绝）：
    # 回退到白纸区域检测定位曲谱区域
    paper = find_paper_band(gray)
    if paper is not None:
        paper_top, paper_bottom = paper
        # 白带最小高度校验：片头/片尾画面顶部的白色薄条（标题卡/字幕条，
        # 实测仅 4%~11% 视频高）不是乐谱；正常乐谱带实测 >=15%~47%h。
        band_h = paper_bottom - paper_top + 1
        if band_h >= h * min_band_ratio:
            white_mask = gray > 200
            band = white_mask[paper_top:paper_bottom + 1]
            xs = np.where(band.any(axis=0))[0]
            if len(xs):
                x1 = max(0, int(xs.min()) - pad)
                y1 = max(0, paper_top)
                x2 = min(w, int(xs.max()) + pad + 1)
                y2 = min(h, paper_bottom + 1)
                # paper_bottom 行本身 ≥90% 白，通常无事发生；统一走尾部修剪防边界情况
                return _trim_trailing_dark(gray, (x1, y1, x2, y2))
    return None


def crop_score(img, rect, top_offset=0, bottom_offset=0, left_offset=0, right_offset=0):
    """
    裁剪乐谱区域，支持额外偏移调整
    
    Args:
        img: 原图
        rect: (x1, y1, x2, y2) 检测到的矩形区域
        top_offset: 上方额外裁剪像素（正数裁更多，负数加回）
        bottom_offset: 下方额外裁剪像素
        left_offset: 左侧额外裁剪像素
        right_offset: 右侧额外裁剪像素
    """
    if rect is None:
        return None
    x1, y1, x2, y2 = rect
    
    # 应用偏移
    x1 = max(0, x1 + left_offset)
    y1 = max(0, y1 + top_offset)
    x2 = min(img.shape[1], x2 + right_offset)
    y2 = min(img.shape[0], y2 + bottom_offset)
    
    cropped = img[y1:y2, x1:x2]
    cropped = refine_top_by_projection(cropped)
    return cropped