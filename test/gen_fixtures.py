"""
跨语言对齐 fixtures 生成器（parity 测试的 Python oracle）

生成 extension/test/fixtures/：
  *.png        无损输入图（浏览器端 canvas 解码后与 cv2.imread 逐字节一致）
  cases.json   各用例的 Python 期望输出（rect / crop 哈希 / 去重判定 / 相位相关位移）

用法:
    uv run python test/gen_fixtures.py
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import imageio.v3 as iio

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src" / "videocore"))

from score_detect import find_score_rect, crop_score  # noqa: E402
from pic_clip import refine_top_by_projection  # noqa: E402
from dedup import ImageDedup, _extract_score_binary, _scores_same  # noqa: E402

OUT = REPO / "extension" / "test" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

# 每个视频一次顺序解码收集所需帧（cv2 seek 不可靠）
NEED = {
    "blues": (
        "data/Blues指弹 美式指弹 入门攻略 --经典指弹Blues曲例/video/"
        "Blues指弹 美式指弹 入门攻略 --经典指弹Blues曲例.mp4",
        [186, 248, 310, 372, 13888, 13950, 14012, 15252, 18910, 18972],
    ),
    "leiqiao": (
        "data/【保姆级_“喂”着讲_免费】伍佰《泪桥》间奏Solo教学 附吉他谱  经典吉他Solo精讲06/video/"
        "【保姆级_“喂”着讲_免费】伍佰《泪桥》间奏Solo教学 附吉他谱  经典吉他Solo精讲06.mp4",
        [18600, 18650, 18675, 18700, 18750, 18000, 14700],
    ),
    "gary": (
        "data/Gary Moore Style in A/video/Gary Moore Style in A.mp4",
        [50, 1542],
    ),
}


def fnv1a(data) -> int:
    h = 2166136261
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


def gray_fnv(mat_gray) -> int:
    return fnv1a(mat_gray.reshape(-1).tolist())


def collect_frames():
    frames = {}
    for key, (path, indices) in NEED.items():
        want = set(indices)
        n = 0
        for fr in iio.imiter(REPO / path, plugin="FFMPEG"):
            if n in want:
                frames[(key, n)] = cv2.cvtColor(fr, cv2.COLOR_RGB2BGR)
            n += 1
            if n > max(want):
                break
        print(f"[{key}] 收集 {sum(1 for k in frames if k[0] == key)} 帧")
    return frames


def main():
    frames = collect_frames()
    cases = {
        "rect_cases": [],
        "refine_cases": [],
        "binary_cases": [],
        "phasecorr_cases": [],
        "dedup_cases": [],
        "chain_cases": [],
    }

    # ---- 1. findScoreRect（灰度 PNG + 期望 rect）----
    for (key, idx), bgr in sorted(frames.items()):
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        png = f"rect_{key}_{idx:06d}.png"
        # 先写再读回，保证期望与浏览器解码输入逐字节一致
        assert cv2.imwrite(str(OUT / png), gray)
        g2 = cv2.imread(str(OUT / png), cv2.IMREAD_GRAYSCALE)
        # find_score_rect 入参为 BGR（内部转灰）；灰度三通道化往返无损
        rect = find_score_rect(cv2.cvtColor(g2, cv2.COLOR_GRAY2BGR))
        cases["rect_cases"].append({
            "name": f"{key}_{idx}",
            "png": png,
            "rect": list(rect) if rect is not None else None,
        })

    # ---- 2. cropScore+refine（BGR PNG → crop 灰度哈希）----
    for key, idx in [("blues", 372), ("blues", 13950), ("leiqiao", 18675), ("leiqiao", 18600)]:
        bgr = frames[(key, idx)]
        png = f"crop_{key}_{idx:06d}.png"
        assert cv2.imwrite(str(OUT / png), bgr)
        src = cv2.imread(str(OUT / png))          # BGR，与浏览器 RGBA→BGR 一致
        rect = find_score_rect(src)
        crop = crop_score(src, rect)
        cases["refine_cases"].append({
            "name": f"{key}_{idx}",
            "png": png,
            "rect": list(rect) if rect is not None else None,
            "crop_size": [crop.shape[1], crop.shape[0]],
            "crop_gray_fnv": gray_fnv(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)),
        })

    # ---- 3. extractScoreBinary（骨架哈希）----
    for key, idx in [("blues", 372), ("leiqiao", 18675), ("blues", 186)]:
        png = f"crop_{key}_{idx:06d}.png"
        if not (OUT / png).exists():
            src = frames[(key, idx)]
            assert cv2.imwrite(str(OUT / png), src)
        src = cv2.imread(str(OUT / png))
        bw = _extract_score_binary(src)
        cases["binary_cases"].append({
            "name": f"{key}_{idx}",
            "png": png,
            "bw_fnv": gray_fnv(bw),
        })

    # ---- 4. phaseCorrelate（对 cv2.phaseCorrelate 的位移对齐）----
    base_gray = cv2.imread(str(OUT / "rect_blues_000372.png"), cv2.IMREAD_GRAYSCALE)
    assert base_gray is not None
    h, w = base_gray.shape
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    ref = base_gray.astype(np.float32)
    shifts = [(0, 0), (5, 3), (-7, 11), (25, -9), (30, 0), (0, 20), (-15, -15)]
    for sx, sy in shifts:
        # np.roll: 正 sx → 内容右移（轴1）
        mov = np.roll(np.roll(base_gray, sx, axis=1), sy, axis=0).astype(np.float32)
        (dx, dy), _resp = cv2.phaseCorrelate(ref, mov, win)
        cases["phasecorr_cases"].append({
            "png": "rect_blues_000372.png",
            "roll": [sx, sy],
            "expected": [dx, dy],
        })

    # ---- 5. scoresSame 真实 crop 对（同/异 + ratio 容差）----
    pairs = [
        ("leiqiao", 18675, "leiqiao", 18700),   # 同谱面（修剪后）
        ("blues", 372, "blues", 14012),         # 不同（滚动过）
        ("leiqiao", 18650, "leiqiao", 18675),   # 同谱面不同路径
    ]
    for k1, i1, k2, i2 in pairs:
        c1 = _crop_of(frames, k1, i1)
        c2 = _crop_of(frames, k2, i2)
        p1, p2 = f"dedup_{k1}_{i1:06d}.png", f"dedup_{k2}_{i2:06d}.png"
        assert cv2.imwrite(str(OUT / p1), c1)
        assert cv2.imwrite(str(OUT / p2), c2)
        a = cv2.imread(str(OUT / p1))
        b = cv2.imread(str(OUT / p2))
        same, ratio = _scores_same(_extract_score_binary(a), _extract_score_binary(b), 0.01)
        cases["dedup_cases"].append({
            "a": p1, "b": p2,
            "expected_same": bool(same),
            "expected_ratio": ratio,
        })

    # ---- 6. ImageDedup 链式判定（端到端 kept/skipped）----
    chain = [("leiqiao", 18000), ("leiqiao", 18600), ("leiqiao", 18650),
             ("leiqiao", 18675), ("leiqiao", 18700), ("leiqiao", 18750)]
    chain_pngs = []
    crops = []
    for key, idx in chain:
        c = _crop_of(frames, key, idx)
        p = f"chain_{key}_{idx:06d}.png"
        assert cv2.imwrite(str(OUT / p), c)
        crops.append(cv2.imread(str(OUT / p)))
        chain_pngs.append(p)
    dedup = ImageDedup(0.01)
    expected = []
    for c in crops:
        is_new, _cid = dedup.add(c)
        expected.append(bool(is_new))
    cases["chain_cases"].append({"pngs": chain_pngs, "expected_is_new": expected})

    (OUT / "cases.json").write_text(
        json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    n_png = len(list(OUT.glob("*.png")))
    print(f"fixtures 完成: {n_png} png, "
          f"rect={len(cases['rect_cases'])} refine={len(cases['refine_cases'])} "
          f"binary={len(cases['binary_cases'])} phase={len(cases['phasecorr_cases'])} "
          f"dedup={len(cases['dedup_cases'])} chain={len(cases['chain_cases'])}")


def _crop_of(frames, key, idx):
    bgr = frames[(key, idx)]
    rect = find_score_rect(bgr)
    if rect is None:
        raise SystemExit(f"帧 {key}_{idx} 无 rect，链路 fixture 不成立")
    return crop_score(bgr, rect)


if __name__ == "__main__":
    main()
