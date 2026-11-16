import cv2
import numpy as np
from pathlib import Path
import shutil


def _extract_score_binary(bgr, blue_thresh=40, binary_thresh=100):
    """
    抹掉蓝色播放光标 -> 灰度 -> 固定阈值二值化，提取黑色音符骨架。

    黄色高亮块/浅灰底色灰度约 >=180，黑色音符灰度≈0，用中间阈值 100
    二值化即可自动把高亮/背景变白、音符/谱线保留为黑。

    Args:
        bgr: BGR 图
        blue_thresh: 判定蓝色的阈值（B 通道 - max(R,G) > 该值视为蓝色光标）
        binary_thresh: 二值化阈值（灰度 < 该值保留为黑，否则变白）

    Returns:
        二值图（255=背景，0=音符骨架）
    """
    img = bgr.copy()
    b, g, r = cv2.split(img)
    blue_mask = (b.astype(int) - np.maximum(r, g).astype(int) > blue_thresh)
    img[blue_mask] = [211, 213, 227]  # 填成浅灰底
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gray, binary_thresh, 255, cv2.THRESH_BINARY)
    return bw


def _pad_to_common(a, b, value=255):
    """把两幅二值图补白到相同尺寸（取宽高较大者），应对裁剪高度不一"""
    h = max(a.shape[0], b.shape[0])
    w = max(a.shape[1], b.shape[1])
    pa = np.full((h, w), value, dtype=a.dtype)
    pa[:a.shape[0], :a.shape[1]] = a
    pb = np.full((h, w), value, dtype=b.dtype)
    pb[:b.shape[0], :b.shape[1]] = b
    return pa, pb


def _align_by_translation(ref, mov, max_shift=30):
    """
    用相位相关估计 mov 相对 ref 的平移量，并对齐 mov。

    Returns:
        (aligned, (dx, dy), valid_mask)
    """
    h, w = ref.shape
    ref_f = ref.astype(np.float32)
    mov_f = mov.astype(np.float32)
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    (dx, dy), _response = cv2.phaseCorrelate(ref_f, mov_f, win)

    # 位移过大说明布局根本不同，不强行对齐
    if abs(dx) > max_shift or abs(dy) > max_shift:
        dx, dy = 0.0, 0.0

    # phaseCorrelate: ref(x,y) = mov(x+dx, y+dy)，对齐需平移 (-dx,-dy)
    M = np.float32([[1, 0, -dx], [0, 1, -dy]])
    aligned = cv2.warpAffine(
        mov, M, (w, h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,  # 填成白背景
    )

    # 有效比对区：排除对齐产生的边缘空白；margin 钳制到宽高的 1/4，
    # 保证中心区至少占一半，避免小图 + 大位移时 valid_mask 全空导致去重失效
    margin = int(max(abs(dx), abs(dy))) + 2
    margin_y = min(margin, max(1, h // 4))
    margin_x = min(margin, max(1, w // 4))
    valid_mask = np.zeros((h, w), dtype=bool)
    if h - 2 * margin_y > 0 and w - 2 * margin_x > 0:
        valid_mask[margin_y:h - margin_y, margin_x:w - margin_x] = True
    return aligned, (dx, dy), valid_mask


def _scores_same(bw_ref, bw_mov, max_diff_ratio=0.01):
    """两幅音符骨架是否为同一谱面（忽略蓝色光标/黄色高亮/轻微平移）"""
    if bw_ref.shape != bw_mov.shape:
        bw_ref, bw_mov = _pad_to_common(bw_ref, bw_mov)
    aligned, (dx, dy), valid_mask = _align_by_translation(bw_ref, bw_mov)
    diff = cv2.absdiff(bw_ref, aligned)
    if total := int(np.count_nonzero(valid_mask)):
        diff_mask = (diff > 0) & valid_mask
        diff_pixels = int(np.count_nonzero(diff_mask))
        diff_ratio = diff_pixels / total
    else:
        # valid_mask 意外全空（防御）：回退到全图比对
        diff_ratio = float(np.count_nonzero(diff)) / diff.size
    return diff_ratio <= max_diff_ratio, diff_ratio


class ImageDedup:
    """
    基于曲谱骨架比对的相邻帧去重器

    只对连续的前后帧做重复判定：用颜色 mask 过滤播放光标、相位相关对齐后
    比对音符骨架差异。既不会漏掉时间上分开但内容相同的帧（乐曲重复的小节），
    又能去掉连续近重复的帧。

    Args:
        threshold: 差异像素占比阈值，与上一帧骨架差异占比 <= 该值视为重复
    """

    def __init__(self, threshold=0.01):
        self.threshold = threshold
        self._last_skel = None
        self._active_cluster = 0      # 当前帧所属连续重复段编号
        self._cluster_count = 0

    def add(self, bgr):
        """
        判定并记录一帧

        Args:
            bgr: BGR 图

        Returns:
            (is_new, cluster_id): is_new 为 True 表示保留（与上一帧不同），False 表示重复；
            cluster_id 为该帧所属连续重复段编号（保留帧开启新段，重复帧属于当前段）
        """
        bw = _extract_score_binary(bgr)
        if self._last_skel is not None:
            same, _ = _scores_same(self._last_skel, bw, self.threshold)
            if same:
                self._last_skel = bw
                return False, self._active_cluster
        self._cluster_count += 1
        self._active_cluster = self._cluster_count - 1
        self._last_skel = bw
        return True, self._active_cluster

    @property
    def count(self):
        return self._cluster_count


class ClusterWriter:
    """
    连续重复段中间状态输出器

    把去重过程中的每张图按连续重复段写入 <dir>/cluster_{i}_{j}.jpg，其中 i 为段编号，
    j 为段内序号（0 为保留代表帧，1.. 为连续近重复帧），方便人工核验相邻帧去重效果。
    """

    def __init__(self, dirpath):
        self.dir = Path(dirpath)
        if self.dir.exists():
            shutil.rmtree(self.dir)      # 每次运行聚合前，先删除该路径下所有文件
        self.dir.mkdir(parents=True, exist_ok=True)
        self._counters = {}

    def write(self, img, cluster_id):
        """
        写入一张图到其所属连续重复段

        Args:
            img: BGR 图
            cluster_id: 该图所属连续重复段编号

        Returns:
            写盘是否成功
        """
        j = self._counters.get(cluster_id, 0)
        self._counters[cluster_id] = j + 1
        return cv2.imwrite(str(self.dir / f"cluster_{cluster_id}_{j}.jpg"), img)

    def summary(self):
        """返回段编号 -> 段内张数的有序字典"""
        return dict(sorted(self._counters.items()))
