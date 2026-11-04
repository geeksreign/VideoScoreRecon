"""
曲谱截图一致性比对工具
=====================
两张曲谱截图内容相同，只是：
  - 蓝色播放光标的位置不同
  - 当前播放小节的淡黄色高亮块位置不同
本工具把这些"播放特效"过滤掉，只比对曲谱的静态音符骨架。

核心算法（二值化/对齐/判定）直接复用 src/videocore/dedup.py，
与流水线去重保持同一套实现与阈值语义，避免两处逻辑漂移。

用法:
    python test/comp_similar_pics.py img1 img2 [-t 0.01] [--save-diff out.png]
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src" / "videocore"))

from dedup import (  # noqa: E402
    _align_by_translation,
    _extract_score_binary,
    _pad_to_common,
    _scores_same,
)


def _read_binary(path: str) -> np.ndarray:
    """读图并提取曲谱骨架二值图（与流水线同一实现）"""
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"无法读取图片：{path}")
    return _extract_score_binary(img)


def compare_score_images(path1: str, path2: str,
                         max_diff_ratio: float = 0.01) -> dict:
    """
    比对两张曲谱截图是否为同一张谱面（判定逻辑与 ImageDedup 一致）。

    Parameters
    ----------
    path1, path2 : str
        两张图片路径。
    max_diff_ratio : float
        判定为"相同"的最大差异像素占比，默认 1%。
    """
    bw1 = _read_binary(path1)
    bw2 = _read_binary(path2)

    # 与 dedup._scores_same 相同：尺寸不一致先补白到公共尺寸再比对
    cmp1, cmp2 = (bw1, bw2) if bw1.shape == bw2.shape else _pad_to_common(bw1, bw2)

    same, diff_ratio = _scores_same(bw1, bw2, max_diff_ratio)

    # 可视化：对齐 + 差异图（与判定同源的对齐结果）
    aligned, (dx, dy), valid_mask = _align_by_translation(cmp1, cmp2)
    diff = cv2.absdiff(cmp1, aligned)
    diff_mask = (diff > 0) & valid_mask

    reason = (
        f"对齐偏移 dx={dx:.1f}px dy={dy:.1f}px；"
        f"差异像素占比 {diff_ratio*100:.2f}% "
        f"({'≤' if same else '>'} {max_diff_ratio*100:.1f}% 阈值)"
        + ("" if bw1.shape == bw2.shape else "；尺寸不一致已补白后比对")
    )
    return {
        "same": same,
        "reason": reason,
        "diff_ratio": diff_ratio,
        "diff_pixels": int(np.count_nonzero(diff_mask)),
        "total_pixels": int(np.count_nonzero(valid_mask)),
        "shift": (round(dx, 1), round(dy, 1)),
        "size": (bw1.shape[1], bw1.shape[0]),
        "bw1": bw1,
        "bw2_aligned": aligned,
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
        if not cv2.imwrite(args.save_diff, result["diff_visual"]):
            print(f"错误：差异可视化写入失败: {args.save_diff}", file=sys.stderr)
            sys.exit(1)
        print(f"差异可视化已保存: {args.save_diff}")

    sys.exit(0 if result["same"] else 2)


if __name__ == "__main__":
    main()
