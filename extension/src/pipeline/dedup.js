// 移植自 src/videocore/dedup.py（骨架提取 / 补白 / 平移对齐 / 同异判定 / ImageDedup）
// 注：v1 已按产品决策砍掉 clusters/ 人工核验输出（仅保留 kept/skipped 统计）。
self.VSR = self.VSR || {};

(function () {
  const C = () => VSR.CONST;

  /** 行主序尺寸比较 */
  function sameShape(a, b) {
    return a.rows === b.rows && a.cols === b.cols;
  }

  /**
   * 抹掉蓝色播放光标 → 灰度 → 固定阈值二值化，提取黑色音符骨架。
   * 顺序与 Python 完全一致：先在彩色图上把蓝色像素填成浅灰，再转灰，再阈值。
   * @param {cv.Mat} bgr CV_8UC3
   * @returns {cv.Mat} CV_8U（255=背景，0=音符）
   */
  function extractScoreBinary(bgr) {
    const blueThresh = C().BLUE_THRESH;
    const binThresh = C().BINARY_THRESH;
    const [fb, fg, fr] = C().FILL_BGR;
    const img = bgr.clone();
    const rows = img.rows, cols = img.cols, step = VSR.rowStep(img);
    const d = img.data;
    // 蓝色光标：B - max(R,G) > 40 → 填浅灰（按行步长索引，兼容行对齐填充）
    for (let y = 0; y < rows; y++) {
      const off = y * step;
      for (let x = 0; x < cols; x++) {
        const o = off + x * 3;
        const b = d[o], g = d[o + 1], r = d[o + 2];
        const mx = g > r ? g : r;
        if (b - mx > blueThresh) { d[o] = fb; d[o + 1] = fg; d[o + 2] = fr; }
      }
    }
    const gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);
    img.delete();
    // THRESH_BINARY@100：灰度 > 100 → 255，否则 0（==100 归 0，同 Python）
    const gd = gray.data, gstep = VSR.rowStep(gray);
    for (let y = 0; y < rows; y++) {
      const off = y * gstep;
      for (let x = 0; x < cols; x++) gd[off + x] = gd[off + x] > binThresh ? 255 : 0;
    }
    return gray;
  }

  /** 两幅二值图补白到公共尺寸 */
  function padToCommon(a, b) {
    const h = Math.max(a.rows, b.rows), w = Math.max(a.cols, b.cols);
    const pa = new cv.Mat(h, w, cv.CV_8U, new cv.Scalar(255));
    const pb = new cv.Mat(h, w, cv.CV_8U, new cv.Scalar(255));
    a.copyTo(pa.rowRange(0, a.rows).colRange(0, a.cols));
    b.copyTo(pb.rowRange(0, b.rows).colRange(0, b.cols));
    return [pa, pb];
  }

  /**
   * 相位相关估计 mov 相对 ref 的平移并平移对齐（语义同 Python
   * _align_by_translation：>max_shift 放弃、白底填充、生成有效比对 mask）
   * @param {cv.Mat} ref CV_8U
   * @param {cv.Mat} mov CV_8U
   * @returns {{aligned: cv.Mat, dx: number, dy: number, validMask: Uint8Array}}
   */
  function alignByTranslation(ref, mov) {
    const maxShift = C().MAX_SHIFT;
    const w = ref.cols, h = ref.rows;
    const refF = new cv.Mat(), movF = new cv.Mat();
    ref.convertTo(refF, cv.CV_32F);
    mov.convertTo(movF, cv.CV_32F);
    const refArr = new Float32Array(refF.data.buffer, refF.data.byteOffset, w * h);
    const movArr = new Float32Array(movF.data.buffer, movF.data.byteOffset, w * h);
    let { dx, dy } = VSR.phaseCorrelate(refArr, movArr, w, h);
    refF.delete(); movF.delete();
    if (Math.abs(dx) > maxShift || Math.abs(dy) > maxShift) { dx = 0; dy = 0; }

    const M = cv.matFromArray(2, 3, cv.CV_32F, [1, 0, -dx, 0, 1, -dy]);
    const aligned = new cv.Mat();
    cv.warpAffine(mov, aligned, M, new cv.Size(w, h), cv.INTER_NEAREST,
      cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255));
    M.delete();

    const margin = Math.trunc(Math.max(Math.abs(dx), Math.abs(dy))) + C().DEDUP_EPS;
    const marginY = Math.min(margin, Math.max(1, Math.floor(h / 4)));
    const marginX = Math.min(margin, Math.max(1, Math.floor(w / 4)));
    const validMask = new Uint8Array(w * h);
    if (h - 2 * marginY > 0 && w - 2 * marginX > 0) {
      for (let y = marginY; y < h - marginY; y++) {
        validMask.fill(1, y * w + marginX, y * w + (w - marginX));
      }
    }
    return { aligned, dx, dy, validMask };
  }

  /**
   * 两幅骨架是否同一谱面
   * @returns {{same: boolean, ratio: number}}
   */
  function scoresSame(bwRef, bwMov, maxDiffRatio) {
    let a = bwRef, b = bwMov, padded = null;
    if (!sameShape(bwRef, bwMov)) {
      padded = padToCommon(bwRef, bwMov);
      a = padded[0]; b = padded[1];
    }
    const { aligned, validMask } = alignByTranslation(a, b);
    const diff = new cv.Mat();
    cv.absdiff(a, aligned, diff);
    const w = a.cols, h = a.rows;
    const dd = diff.data, dstep = VSR.rowStep(diff);
    let total = 0, diffPixels = 0, allNonzero = 0;
    for (let y = 0; y < h; y++) {
      const off = y * dstep;
      for (let x = 0; x < w; x++) {
        const nz = dd[off + x] !== 0;
        if (nz) allNonzero++;
        if (validMask[y * w + x]) {
          total++;
          if (nz) diffPixels++;
        }
      }
    }
    aligned.delete(); diff.delete();
    if (padded) { padded[0].delete(); padded[1].delete(); }
    let ratio;
    if (total > 0) ratio = diffPixels / total;
    else ratio = allNonzero / (w * h);   // valid_mask 全空防御：回退全图
    return { same: ratio <= maxDiffRatio, ratio };
  }

  /** 相邻帧去重器（cluster 语义同 Python） */
  class ImageDedup {
    constructor(threshold) {
      this.threshold = threshold === undefined ? C().DEFAULT_DEDUP_THRESHOLD : threshold;
      this._lastSkel = null;      // cv.Mat | null
      this._activeCluster = 0;
      this._clusterCount = 0;
    }

    /** @returns {{isNew: boolean, clusterId: number}} */
    add(bgr) {
      const bw = extractScoreBinary(bgr);
      if (this._lastSkel !== null) {
        const { same } = scoresSame(this._lastSkel, bw, this.threshold);
        if (same) {
          this._lastSkel.delete();
          this._lastSkel = bw;
          return { isNew: false, clusterId: this._activeCluster };
        }
      }
      this._clusterCount++;
      this._activeCluster = this._clusterCount - 1;
      if (this._lastSkel) this._lastSkel.delete();
      this._lastSkel = bw;
      return { isNew: true, clusterId: this._activeCluster };
    }

    get count() { return this._clusterCount; }

    dispose() {
      if (this._lastSkel) { this._lastSkel.delete(); this._lastSkel = null; }
    }
  }

  VSR.extractScoreBinary = extractScoreBinary;
  VSR.padToCommon = padToCommon;
  VSR.alignByTranslation = alignByTranslation;
  VSR.scoresSame = scoresSame;
  VSR.ImageDedup = ImageDedup;
})();

console.log('[load] dedup.js');
