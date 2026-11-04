"""
曲谱截图一致性比对工具
======================
两张曲谱截图内容相同，只是：
  - 蓝色播放光标的位置不同
  - 当前播放小节的淡黄色高亮块位置不同
本工具把这些"播放特效"过滤掉，只比对曲谱的静态音符骨架。

原理
----
1. 蓝色光标：B 通道明显高于 R/G，用颜色 mask 抠掉并填成底色；
2. 淡黄色高亮块：灰度约 180，浅灰底色约 211，都远高于黑色音符(灰度≈0)，
   所以**不需要抹黄色块**，用一个中间阈值(100)二值化即可自动分离：
     灰度 < 100  → 黑色音符/谱线（保留）
     灰度 ≥ 100  → 黄底 / 灰底（变白背景）
3. 对齐：用相位相关 (cv2.phaseCorrelate) 估计图2相对图1的整像素平移量，
   warpAffine 对齐后再逐像素比对，吸收截图轻微偏移；
4. 差异像素占比 < 阈值（默认 1%）即判定为同一张曲谱。

"""

import argparse
import os
import sys

import cv2
import numpy as np


# ---------------------------- 核心算法 ---------------------------- #

def _extract_score_binary(image_path: str, blue_thresh: int = 40,
                          binary_thresh: int = 100) -> np.ndarray:
    """
    读取曲谱截图 → 抹掉蓝色光标 → 二值化提取黑色音符骨架。

    Parameters
    ----------
    image_path : str
        图片路径。
    blue_thresh : int
        判定蓝色的阈值：B 通道 - max(R,G) 大于该值即视为蓝色光标。
    binary_thresh : int
        二值化阈值：灰度 < 该值保留为黑（音符），否则变白。
    """
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"无法读取图片：{image_path}")

    b, g, r = cv2.split(img)

    # 1) 抠掉蓝色光标
    blue_mask = (b.astype(int) - np.maximum(r, g).astype(int) > blue_thresh)
    img[blue_mask] = [211, 213, 227]  # 填成浅灰底

    # 2) 灰度 + 固定阈值二值化（黄色高亮块此时自动变成白背景）
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gray, binary_thresh, 255, cv2.THRESH_BINARY)
    return bw


def _align_by_translation(ref: np.ndarray, mov: np.ndarray,
                          max_shift: int = 30):
    """
    用相位相关估计 mov 相对 ref 的平移量，并对齐 mov。

    Returns
    -------
    aligned : np.ndarray
        对齐后的 mov（与 ref 同尺寸）。
    shift : (dx, dy)
        估计到的平移量（像素）。
    valid_mask : np.ndarray (bool)
        有效比对区域（排除边缘填充），True=参与比对。
    """
    h, w = ref.shape
    ref_f = ref.astype(np.float32)
    mov_f = mov.astype(np.float32)
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    (dx, dy), _response = cv2.phaseCorrelate(ref_f, mov_f, win)

    # 位移过大说明布局根本不同，不强行对齐
    if abs(dx) > max_shift or abs(dy) > max_shift:
        dx, dy = 0.0, 0.0

    # phaseCorrelate: ref(x,y) = mov(x+dx, y+dy)，要把 mov 对齐到 ref 需平移 (-dx,-dy)
    M = np.float32([[1, 0, -dx], [0, 1, -dy]])
    aligned = cv2.warpAffine(
        mov, M, (w, h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,  # 填成白背景，与曲谱底色一致
    )

    # 有效区域：边缘 margin 像素不参与比对
    margin = int(max(abs(dx), abs(dy))) + 2
    valid_mask = np.zeros((h, w), dtype=bool)
    valid_mask[margin:h - margin, margin:w - margin] = True
    return aligned, (dx, dy), valid_mask


def compare_score_images(path1: str, path2: str,
                         max_diff_ratio: float = 0.01) -> dict:
    """
    比对两张曲谱截图是否为同一张谱面。

    Parameters
    ----------
    path1, path2 : str
        两张图片路径。
    max_diff_ratio : float
        判定为"相同"的最大差异像素占比，默认 1%。
    """
    bw1 = _extract_score_binary(path1)
    bw2 = _extract_score_binary(path2)

    # 尺寸不一致说明不是同一张截图布局，直接判定不同
    if bw1.shape != bw2.shape:
        return {
            "same": False,
            "reason": f"尺寸不一致 {bw1.shape} vs {bw2.shape}",
            "diff_ratio": 1.0,
            "diff_pixels": int(bw1.size),
        }

    # 对齐：把 bw2 平移到 bw1
    bw2_aligned, (dx, dy), valid_mask = _align_by_translation(bw1, bw2)

    diff = cv2.absdiff(bw1, bw2_aligned)
    diff_mask = (diff > 0) & valid_mask
    diff_pixels = int(np.count_nonzero(diff_mask))
    total = int(np.count_nonzero(valid_mask))
    diff_ratio = diff_pixels / total if total else 1.0

    same = diff_ratio <= max_diff_ratio
    return {
        "same": same,
        "reason": (
            f"对齐偏移 dx={dx:.1f}px dy={dy:.1f}px；"
            f"差异像素占比 {diff_ratio*100:.2f}% "
            f"({'≤' if same else '>'} {max_diff_ratio*100:.1f}% 阈值)"
        ),
        "diff_ratio": diff_ratio,
        "diff_pixels": diff_pixels,
        "total_pixels": total,
        "shift": (round(dx, 1), round(dy, 1)),
        "size": (bw1.shape[1], bw1.shape[0]),
        "bw1": bw1,
        "bw2_aligned": bw2_aligned,
        "diff_visual": diff,
        "valid_mask": valid_mask,
    }


# ---------------------------- 命令行入口 ---------------------------- #

def main():
    ap = argparse.ArgumentParser(
        description="比对两张曲谱截图是否为同一张（忽略蓝色光标和黄色高亮位置）。"
    )
    ap.add_argument("image1", help="第一张图片路径")
    ap.add_argument("image2", help="第二张图片路径")
    ap.add_argument("-t", "--threshold", type=float, default=0.01,
                    help="判定相同的差异像素占比阈值，默认 0.01 (1%%)")
    ap.add_argument("--save-diff", default=None,
                    help="可选：把差异可视化图保存到该路径")
    args = ap.parse_args()

    try:
        result = compare_score_images(args.image1, args.image2, args.threshold)
    except FileNotFoundError as e:
        print(f"错误：{e}", file=sys.stderr)
        sys.exit(1)

    print(f"图片尺寸      : {result.get('size')}")
    print(f"对齐偏移      : dx={result['shift'][0]}px, dy={result['shift'][1]}px")
    print(f"差异像素数    : {result.get('diff_pixels', 'N/A')} "
          f"/ {result.get('total_pixels', 'N/A')}")
    print(f"差异占比      : {result.get('diff_ratio', 1.0)*100:.2f}%")
    print(f"判定结果      : {'✅ 相同曲谱' if result['same'] else '❌ 不同曲谱'}")
    print(f"说明          : {result['reason']}")

    if args.save_diff:
        cv2.imwrite(args.save_diff, result["diff_visual"])
        print(f"差异可视化已保存: {args.save_diff}")

    sys.exit(0 if result["same"] else 2)


if __name__ == "__main__":
    main()


# if __name__ == "__main__":
#     # 修改为你的两张截图路径
#     img_a = "/Users/yi/workwork/plugins/VideoScoreRecon/data/001 Intro Acoustic Shuffle E7 Shuffle 1_哔哩哔哩_bilibili/clusters/cluster_0_2.jpg"
#     img_b = "/Users/yi/workwork/plugins/VideoScoreRecon/data/001 Intro Acoustic Shuffle E7 Shuffle 1_哔哩哔哩_bilibili/clusters/cluster_1_0.jpg"
#     same, msg = is_same_sheet(img_a, img_b)
#     print(msg)