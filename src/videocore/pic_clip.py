import cv2
import numpy as np


def find_paper_band(gray, frac=0.9, run=6):
    """
    通过亮度剖面找到白色曲谱区域（背景与白色区域的分界线）

    逐行统计近白像素（>200）数量，白纸 = 连续且占比超过 frac 宽度的行段。

    Args:
        gray: 灰度图
        frac: 判定为白纸的近白像素占宽度的最小比例
        run: 需要连续满足的最小行数（排除噪声行）

    Returns:
        (paper_top, paper_bottom) 或 None（未找到白纸区域）
    """
    h, w = gray.shape
    white = (gray > 200).sum(axis=1)
    threshold = w * frac
    paper_top = None
    paper_bottom = None
    r = 0
    while r < h:
        if white[r] >= threshold:
            j = r
            while j < h and white[j] >= threshold:
                j += 1
            if j - r >= run:
                if paper_top is None:
                    paper_top = r
                paper_bottom = j - 1
            r = j
        else:
            r += 1
    if paper_top is None:
        return None
    return paper_top, paper_bottom


def refine_top_by_projection(cropped_img, line_thickness=3):
    """
    通过白纸边界 + 暗像素水平投影精修乐谱上边界

    两层策略：
    1. 先用亮度剖面找白纸区域（背景/曲谱分界线），给出稳健的上界；
    2. 在白纸内用低阈值找第一条暗带（谱线），仅当它靠近白纸顶部时才采用，
       否则回退到白纸顶部，避免把较淡/倾斜的顶部谱线裁掉。

    Args:
        cropped_img: 初步裁剪后的图像
        line_thickness: 保留参数，兼容旧调用

    Returns:
        上边界精修后的裁剪图像
    """
    gray = cv2.cvtColor(cropped_img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    paper = find_paper_band(gray)
    if paper is None:
        return cropped_img
    paper_top, paper_bottom = paper

    # 白纸内暗像素水平投影
    region = gray[paper_top:paper_bottom + 1]
    _, binary = cv2.threshold(region, 150, 255, cv2.THRESH_BINARY_INV)
    projection = np.sum(binary, axis=1) / 255

    # 低绝对阈值，捕捉较淡或倾斜的谱线
    threshold = max(w * 0.005, 2)
    first = None
    r = 0
    rh = len(projection)
    while r < rh:
        if projection[r] > threshold:
            first = r
            break
        r += 1

    # 安全护栏：第一条暗带须在白纸顶部 30% 以内，否则回退白纸顶部
    paper_h = paper_bottom - paper_top + 1
    if first is not None and first <= 0.30 * paper_h:
        margin = 2
        refined_y1 = max(0, paper_top + first - margin)
        return cropped_img[refined_y1:h, :]
    return cropped_img[max(0, paper_top - 2):h, :]
