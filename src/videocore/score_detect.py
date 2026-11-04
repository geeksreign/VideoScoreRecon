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


def find_score_rect(img, thresh=200, min_w_ratio=0.5, min_h_ratio=0.08,
                    top_ratio=0.18, bottom_ratio=0.35, pad=6):  # 调小了 top_ratio
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
            return (max(0, x - pad), max(0, y - pad),
                    min(w, x + cw + pad), min(h, y + ch + pad))

    # 无合格四边形候选（或全部被内容校验拒绝）：
    # 回退到白纸区域检测定位曲谱区域
    paper = find_paper_band(gray)
    if paper is not None:
        paper_top, paper_bottom = paper
        white_mask = gray > 200
        band = white_mask[paper_top:paper_bottom + 1]
        xs = np.where(band.any(axis=0))[0]
        if len(xs):
            x1 = max(0, int(xs.min()) - pad)
            y1 = max(0, paper_top)
            x2 = min(w, int(xs.max()) + pad + 1)
            y2 = min(h, paper_bottom + 1)
            return x1, y1, x2, y2
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