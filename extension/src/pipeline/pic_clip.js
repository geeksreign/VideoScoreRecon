// 移植自 src/videocore/pic_clip.py（find_paper_band / refine_top_by_projection）
self.VSR = self.VSR || {};

(function () {
  const C = () => VSR.CONST;

  /**
   * 逐行统计近白像素，返回连续满足行段包络 (top, bottom) 或 null
   * @param {cv.Mat} gray CV_8U 灰度图
   * @returns {{top:number, bottom:number}|null}
   */
  function findPaperBand(gray, frac, run) {
    frac = frac === undefined ? C().PAPER_FRAC : frac;
    run = run === undefined ? C().PAPER_RUN : run;
    const h = gray.rows, w = gray.cols;
    const data = gray.data;
    const step = VSR.rowStep(gray);
    const level = C().PAPER_LEVEL;
    const threshold = w * frac;
    let top = null, bottom = null;
    let r = 0;
    while (r < h) {
      // 统计该行近白数
      let cnt = 0;
      const off = r * step;
      for (let x = 0; x < w; x++) if (data[off + x] > level) cnt++;
      if (cnt >= threshold) {
        let j = r;
        while (j < h) {
          let cj = 0;
          const oj = j * step;
          for (let x = 0; x < w; x++) if (data[oj + x] > level) cj++;
          if (cj >= threshold) j++; else break;
        }
        if (j - r >= run) {
          if (top === null) top = r;
          bottom = j - 1;
        }
        r = j;
      } else {
        r++;
      }
    }
    if (top === null) return null;
    return { top, bottom };
  }

  /**
   * 白纸带 + 暗像素投影精修上边界（只裁上边界，语义同 Python）
   * @param {cv.Mat} crop BGR 裁剪图
   * @returns {cv.Mat} 新 Mat（调用方负责 delete）
   */
  function refineTopByProjection(crop) {
    const gray = new cv.Mat();
    cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
    const h = gray.rows, w = gray.cols;
    const paper = findPaperBand(gray);
    if (paper === null) {
      gray.delete();
      return crop.clone();
    }
    const { top, bottom } = paper;
    // 白带内暗像素行投影。Python: cv2.threshold(..., 150, THRESH_BINARY_INV)
    // → 灰度 <= 150 计为暗（注意与 numpy 的 < 150 不同）
    const data = gray.data, step = VSR.rowStep(gray);
    const level = C().REFINE_LEVEL;
    const rh = bottom - top + 1;
    const projection = new Float64Array(rh);
    for (let y = top; y <= bottom; y++) {
      const off = y * step;
      let cnt = 0;
      for (let x = 0; x < w; x++) if (data[off + x] <= level) cnt++;
      projection[y - top] = cnt;
    }
    const thr = Math.max(w * C().REFINE_RATIO, 2);
    let first = -1;
    for (let i = 0; i < rh; i++) {
      if (projection[i] > thr) { first = i; break; }
    }
    const paperH = rh;
    let refinedY1;
    if (first >= 0 && first <= C().REFINE_GUARD * paperH) {
      refinedY1 = Math.max(0, top + first - C().REFINE_MARGIN);
    } else {
      refinedY1 = Math.max(0, top - C().REFINE_MARGIN);
    }
    gray.delete();
    const out = crop.rowRange(refinedY1, h).clone();
    return out;
  }

  VSR.findPaperBand = findPaperBand;
  VSR.refineTopByProjection = refineTopByProjection;
})();

console.log('[load] pic_clip.js');
