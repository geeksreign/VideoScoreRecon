#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
吉他谱截图自动裁剪工具
======================
自动识别截图中【视频画面 ↔ 曲谱区域】的水平分界线，只保留曲谱部分。

特点
----
1. 不假设曲谱在上方还是下方，自动判断纹理突变方向；
2. 不依赖纯白背景，浅灰、淡黄等曲谱底色都能识别；
3. 用「行内像素标准差」区分视频画面（纹理杂乱、std 大）和曲谱区域
   （底色均匀、std 小），比单纯看平均亮度更稳健；
4. 支持单张或批量处理。

依赖
----
    pip install pillow numpy
"""

import sys
import os
import argparse
from glob import glob

import numpy as np
from PIL import Image


# ---------------------------- 核心算法 ---------------------------- #

def find_score_boundary(img: Image.Image, smooth_win: int = 15, pad: int = 3):
    """
    在一张图中寻找视频区与曲谱区的水平分界线。

    原理
    ----
    对每一行计算行内像素标准差 std(y)：
      - 视频画面：人物、吉他、户外背景颜色杂乱 → std 大
      - 曲谱区域：底色均匀（即使有音符，音符只占少量像素）→ std 小
    对 std 做滑动平均平滑后，找相邻行 std 差分绝对值最大的位置，
    即为纹理突变分界线。

    Parameters
    ----------
    img : PIL.Image
        输入图片。
    smooth_win : int
        行标准差滑动平均窗口，抑制音符行造成的波动。
    pad : int
        分界行向外多切的行数，避免残留抗锯齿过渡带。

    Returns
    -------
    crop_box : (left, upper, right, lower)
        应保留的曲谱区域裁剪框（PIL 坐标系）。
    info : dict
        调试信息：分界行、上下段 std/mean 等。
    """
    arr = np.asarray(img.convert("RGB"))
    h, w, _ = arr.shape
    gray = arr.mean(axis=2)

    row_mean = gray.mean(axis=1)          # 每行平均亮度
    row_std = gray.std(axis=1)             # 每行像素纹理复杂度

    # 滑动平均平滑，去掉音符行/细线条造成的尖峰
    kernel = np.ones(smooth_win) / smooth_win
    sm_std = np.convolve(row_std, kernel, mode="same")
    sm_mean = np.convolve(row_mean, kernel, mode="same")

    # 纹理差分：相邻行 std 变化幅度
    diff = np.abs(np.diff(sm_std))
    # 排除图片上下边缘（通常是窗口边框/黑边）
    edge = max(smooth_win, 20)
    diff[:edge] = 0.0
    diff[-edge:] = 0.0

    y = int(np.argmax(diff))               # 最大纹理突变行

    # 分界上下各取 40 行做特征对比
    seg_top = slice(max(0, y - 40), y)
    seg_bot = slice(y + 1, min(h, y + 41))
    above_std = sm_std[seg_top].mean()
    below_std = sm_std[seg_bot].mean()
    above_mean = sm_mean[seg_top].mean()
    below_mean = sm_mean[seg_bot].mean()

    # 曲谱侧 = 纹理更均匀（std 更小）的一侧
    if below_std < above_std:
        # 曲谱在下方
        upper = min(y + 1 + pad, h)
        lower = h
        side = "below"
    else:
        # 曲谱在上方
        upper = 0
        lower = max(y - pad, 0)
        side = "above"

    crop_box = (0, upper, w, lower)
    info = {
        "size": (w, h),
        "boundary_y": y,
        "side": side,
        "above_std": round(float(above_std), 1),
        "below_std": round(float(below_std), 1),
        "above_mean": round(float(above_mean), 1),
        "below_mean": round(float(below_mean), 1),
        "crop_box": crop_box,
    }
    return crop_box, info


def crop_score_region(input_path: str, output_path: str) -> dict:
    """读取图片 → 找分界 → 裁剪并保存。"""
    img = Image.open(input_path)
    box, info = find_score_boundary(img)
    out = img.crop(box)
    out.save(output_path)
    info["output_size"] = out.size
    info["output_path"] = output_path
    return info


# ---------------------------- 命令行入口 ---------------------------- #

def main():
    ap = argparse.ArgumentParser(
        description="自动裁剪吉他谱截图中的曲谱区域（去掉视频画面）。"
    )
    ap.add_argument(
        "inputs",
        nargs="+",
        help="输入图片路径，支持通配符，如 *.png 或 a.png b.png",
    )
    ap.add_argument(
        "-o", "--out-dir",
        help="输出目录",
    )
    ap.add_argument(
        "--suffix",
        default="_score",
        help="输出文件名后缀（默认 _score）",
    )
    args = ap.parse_args()

    # 展开通配符
    files = []
    for pattern in args.inputs:
        matched = sorted(glob(pattern))
        if not matched and os.path.exists(pattern):
            matched = [pattern]
        files.extend(matched)

    if not files:
        print("未找到输入文件", file=sys.stderr)
        sys.exit(1)
    if not args.out_dir:
        args.out_dir = os.path.dirname(files[0])
    os.makedirs(args.out_dir, exist_ok=True)


    for path in files:
        base = os.path.splitext(os.path.basename(path))[0]
        out_path = os.path.join(args.out_dir, f"{base}{args.suffix}.png")
        try:
            info = crop_score_region(path, out_path)
        except Exception as e:
            print(f"[失败] {path}: {e}", file=sys.stderr)
            continue
        print(
            f"[完成] {os.path.basename(path)} "
            f"→ {out_path}  "
            f"(分界 y={info['boundary_y']}, 曲谱在{info['side']}, "
            f"输出 {info['output_size'][0]}x{info['output_size'][1]})"
        )

# ===================== 【这里修改你的图片路径，直接运行】=====================
if __name__ == "__main__":
    # 替换成你本地图片的路径，例如 r"C:\test\guitar.png"
    main()