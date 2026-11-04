import re
import shutil

import cv2
from pathlib import Path
from score_detect import find_score_rect, crop_score
from dedup import ImageDedup, ClusterWriter
import imageio.v3 as iio
import numpy as np


def stitch_scores(out_dir, output_path=None):
    """
    按时间顺序（文件名数字序）将保留的裁剪图纵向拼接成一张长图

    Args:
        out_dir: 保存 score_*.jpg 的目录
        output_path: 拼接输出路径（默认 <out_dir>/score_stitched.png）

    Returns:
        输出路径；若无图可拼或写盘失败则返回 None
    """
    out_dir = Path(out_dir)
    # 仅匹配抽帧裁剪图 score_<帧号>.jpg，避免把拼接输出本身拼进去
    # （帧号位数不固定：≥100 万帧会产生 7 位；按数字大小而非字典序排序）
    files = sorted(
        (f for f in out_dir.iterdir() if re.fullmatch(r'score_\d+\.jpg', f.name)),
        key=lambda f: int(re.search(r'\d+', f.stem).group()),
    )
    imgs = [cv2.imread(str(f)) for f in files]
    imgs = [i for i in imgs if i is not None]
    if not imgs:
        return None

    w = max(i.shape[1] for i in imgs)
    resized = [i if i.shape[1] == w else cv2.resize(i, (w, i.shape[0])) for i in imgs]
    stitched = np.vstack(resized)

    output_path = Path(output_path) if output_path else out_dir / "score_stitched.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # JPEG 有 65535px 高度上限，长视频拼接图必须用 PNG
    ok = cv2.imwrite(str(output_path), stitched)
    if not ok:
        print(f"[警告] 写入失败: {output_path}")
        return None
    return output_path


def _clean_dir(path):
    """删除并重建一个可再生产物目录"""
    path = Path(path)
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def extract_and_crop(video_path, data_dir, interval_sec=2, dedup_threshold=0.01, stitch=True,
                     start_time=None, end_time=None, on_progress=None):
    """
    从视频抽取并裁剪曲谱区域（相邻帧去重 + 拼接）

    按视频名自动组织目录结构：
        <data_dir>/<视频名>/video/<视频>   输入视频（自动移入）
        <data_dir>/<视频名>/crops/         去重后的裁剪图
        <data_dir>/<视频名>/clusters/      连续重复段核验中间状态
        <data_dir>/<视频名>/final/res.png  拼接结果

    Args:
        video_path: 输入视频路径（若不在 video/ 内会自动移入）
        data_dir: 数据根目录
        interval_sec: 抽帧间隔秒数
        dedup_threshold: 曲谱骨架差异占比阈值，与上一帧差异 <= 该值视为重复
        stitch: 是否执行最终拼接
        start_time: 截取开始时间（秒，None 表示从视频开头）
        end_time: 截取截止时间（秒，None 表示到视频结尾）
        on_progress: 可选回调 on_progress(stage, progress, message)，
                     stage 为 'extract'/'stitch'/'done'，progress 为 0~1

    Returns:
        保存的裁剪图数量
    """
    def report(stage, progress, message=""):
        if on_progress:
            on_progress(stage, progress, message)

    video_path = Path(video_path)
    data_dir = Path(data_dir)
    stem = video_path.stem

    base = data_dir / stem
    video_dir = base / "video"
    crops_dir = base / "crops"
    clusters_dir = base / "clusters"
    final_dir = base / "final"

    # 解析输入视频：给定路径存在则用，否则回退到 <stem>/video/<原名>
    src = video_path
    if not src.exists():
        alt = video_dir / video_path.name
        if alt.exists():
            src = alt
        else:
            raise FileNotFoundError(f"找不到视频: {video_path}（也不在 {video_dir}）")

    # 自动移入 video/ 目录（目标已存在且非同一文件时自动改名，防止覆盖）
    target = video_dir / src.name
    if src.resolve() != target.resolve():
        video_dir.mkdir(parents=True, exist_ok=True)
        if target.exists():
            n = 1
            while True:
                target = video_dir / f"{src.stem}_{n}{src.suffix}"
                if not target.exists():
                    break
                n += 1
            print(f"[提示] {video_dir / src.name} 已存在，改名移入: {target.name}")
        print(f"移动视频: {src} -> {target}")
        shutil.move(str(src), str(target))
        src = target

    # 每次运行前清理可再生产物目录（video/ 不动）
    _clean_dir(crops_dir)
    _clean_dir(clusters_dir)
    _clean_dir(final_dir)

    saved = 0
    skipped = 0
    write_failed = 0
    frame_count = 0
    deduper = ImageDedup(dedup_threshold)
    cluster_writer = ClusterWriter(clusters_dir)

    # 用视频真实帧率计算抽帧步长（而非假设 30fps）
    meta = iio.immeta(str(src))
    fps = meta.get('fps') or 30.0
    duration = meta.get('duration')
    sample_step = max(1, int(round(interval_sec * fps)))

    # 截取区间：秒 -> 帧号
    start_frame = 0 if start_time is None else max(0, int(round(start_time * fps)))
    end_frame = None if end_time is None else int(round(end_time * fps))
    if end_frame is not None:
        if duration and end_time > duration:
            print(f"[提示] end_time {end_time}s 超过视频时长 {duration:.1f}s，截断到视频结尾")
            end_frame = None
        elif start_frame >= end_frame:
            raise ValueError(f"截取区间非法: start={start_frame}({start_time}s) >= end={end_frame}({end_time}s)")
    if start_time is not None:
        print(f"截取区间: [{start_time}s, {end_time if end_time is not None else '结尾'}s] -> 帧 [{start_frame}, {end_frame if end_frame is not None else '结尾'}]")
    print(f"视频帧率: {fps} fps，抽帧步长: {sample_step} 帧（约 {interval_sec}s/帧）")

    # 采样上界（仅用于末尾补采样；end_time 未设时用视频时长估算，循环不提前 break）
    sample_end = end_frame
    if sample_end is None and duration:
        sample_end = int(round(duration * fps))

    total_frames = int(round(duration * fps)) if duration else None
    last_pct = -1

    def tick_progress(force_msg=None):
        """按 1% 粒度节流上报 extract 进度"""
        nonlocal last_pct
        if not total_frames:
            return
        if frame_count % max(1, total_frames // 100) != 0:
            return
        pct = int(frame_count / total_frames * 100)
        if pct == last_pct and not force_msg:
            return
        last_pct = pct
        msg = force_msg or f"抽帧 {frame_count}/{total_frames}"
        report("extract", min(1.0, frame_count / total_frames), msg)

    frames = iio.imiter(str(src), plugin="FFMPEG")
    for frame in frames:
        if frame_count < start_frame:
            frame_count += 1
            # 跳至 start_time 的阶段也上报进度，避免进度条长时间停 0%
            tick_progress(force_msg=f"跳至 {start_time}s: {frame_count}/{start_frame}")
            continue
        if end_frame is not None and frame_count >= end_frame:
            break

        # imageio 返回 RGB，OpenCV 需要 BGR，所以转换一下
        frame_bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

        # 按间隔抽帧：网格对齐区间起点 + 补采区间/视频末尾一帧，避免边界漏采
        on_grid = (frame_count - start_frame) % sample_step == 0
        is_last = sample_end is not None and frame_count == max(start_frame, sample_end - 1)
        if on_grid or is_last:
            rect = find_score_rect(frame_bgr)
            crop = crop_score(frame_bgr, rect)
            if crop is not None:
                # 曲谱骨架比对去重：仅与前一帧比较，重复则跳过
                is_new, cid = deduper.add(crop)
                if not cluster_writer.write(crop, cid):
                    write_failed += 1
                if is_new:
                    if cv2.imwrite(str(crops_dir / f"score_{frame_count:06d}.jpg"), crop):
                        saved += 1
                    else:
                        write_failed += 1
                else:
                    skipped += 1

        frame_count += 1
        tick_progress()

    print(f"保存 {saved} 张，去重跳过 {skipped} 张（阈值 {dedup_threshold}）")
    if write_failed:
        print(f"[警告] {write_failed} 张图写盘失败（磁盘空间/权限？）")
    summary = cluster_writer.summary()
    print(f"连续重复段汇总（共 {len(summary)} 段）:")
    for cid, n in summary.items():
        print(f"  cluster_{cid}: {n} 张")

    if stitch and saved > 0:
        report("stitch", 0.99, "拼接中")
        stitched = stitch_scores(crops_dir, final_dir / "res.png")
        if stitched:
            print(f"拼接完成: {stitched}")
        else:
            print("[警告] 拼接失败（无图可拼或写盘失败）")

    report("done", 1.0, f"保存 {saved} 张")
    return saved
