// 移植自 src/videocore/score_detect.py
// （_looks_like_score / _trim_trailing_dark / find_score_rect / crop_score）
self.VSR = self.VSR || {};

(function () {
  const C = () => VSR.CONST;

  /**
   * 乐谱内容合理性：候选框内暗像素（灰度 < 150）占比须在乐谱典型区间。
   * 用原始候选框（不含 pad）计算——pad 圈在暗背景上会注入边框噪声。
   */
  function looksLikeScore(gray, x, y, cw, ch) {
    const minDark = C().MIN_DARK, maxDark = C().MAX_DARK, level = C().DARK_LEVEL;
    if (cw <= 0 || ch <= 0) return false;
    const step = VSR.rowStep(gray), data = gray.data;
    let dark = 0;
    for (let row = y; row < y + ch; row++) {
      const off = row * step;
      for (let col = x; col < x + cw; col++) if (data[off + col] < level) dark++;
    }
    const ratio = dark / (cw * ch);
    return ratio >= minDark && ratio <= maxDark;
  }

  /**
   * 修剪 rect 尾部连续非白行（对齐 Python _trim_trailing_dark）
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  function trimTrailingDark(gray, rect) {
    const minWhite = C().MIN_WHITE_TRIM;
    const { x: x1, y: y1, w: rw, h: rh } = rect;
    const step = VSR.rowStep(gray), data = gray.data;
    let y2 = y1 + rh;
    const whiteRatio = (row) => {
      const off = row * step;
      let cnt = 0;
      for (let col = x1; col < x1 + rw; col++) if (data[off + col] > C().PAPER_LEVEL) cnt++;
      return cnt / rw;
    };
    while (y2 - 1 >= y1 && whiteRatio(y2 - 1) < minWhite) y2--;
    if (y2 <= y1) return null;
    return { x: x1, y: y1, w: rw, h: y2 - y1 };
  }

  /**
   * 检测乐谱矩形（输入须为灰度图；Python 版入参为 BGR、内部先转灰）
   * @param {cv.Mat} gray CV_8U
   * @returns {{x,y,w,h}|null}
   */
  function findScoreRect(gray, opts) {
    opts = opts || {};
    const thresh = opts.thresh !== undefined ? opts.thresh : C().DETECT_THRESH;
    const minWR = opts.min_w_ratio !== undefined ? opts.min_w_ratio : C().MIN_W_RATIO;
    const minHR = opts.min_h_ratio !== undefined ? opts.min_h_ratio : C().MIN_H_RATIO;
    const topRatio = opts.top_ratio !== undefined ? opts.top_ratio : C().TOP_RATIO;
    const bottomRatio = opts.bottom_ratio !== undefined ? opts.bottom_ratio : C().BOTTOM_RATIO;
    const pad = opts.pad !== undefined ? opts.pad : C().PAD;
    const minBand = opts.min_band_ratio !== undefined ? opts.min_band_ratio : C().MIN_BAND_RATIO;

    const h = gray.rows, w = gray.cols;
    const binary = new cv.Mat();
    cv.threshold(gray, binary, thresh, 255, cv.THRESH_BINARY);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 5));
    const closed = new cv.Mat();
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    binary.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    closed.delete();
    hierarchy.delete();

    const candidates = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.boundingRect(cnt);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
      const nVerts = approx.rows * approx.cols; // int2: N 行 1 列
      approx.delete();
      if (nVerts !== 4) { cnt.delete(); continue; }
      if (rect.width < w * minWR || rect.height < h * minHR) { cnt.delete(); continue; }
      if (!(rect.y < h * topRatio || rect.y > h * (1 - bottomRatio))) { cnt.delete(); continue; }
      candidates.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
      cnt.delete();
    }
    contours.delete();

    // 按面积降序逐个做内容校验
    candidates.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const cd of candidates) {
      if (looksLikeScore(gray, cd.x, cd.y, cd.w, cd.h)) {
        const padded = {
          x: Math.max(0, cd.x - pad),
          y: Math.max(0, cd.y - pad),
          w: Math.min(w, cd.x + cd.w + pad) - Math.max(0, cd.x - pad),
          h: Math.min(h, cd.y + cd.h + pad) - Math.max(0, cd.y - pad),
        };
        const trimmed = trimTrailingDark(gray, padded);
        if (trimmed !== null) return trimmed;
        // 修剪为空 → 顺位尝试下一个候选
      }
    }

    // 回退：白纸带（含最小高度校验 + 统一尾部修剪）
    const paper = VSR.findPaperBand(gray);
    if (paper !== null) {
      const bandH = paper.bottom - paper.top + 1;
      if (bandH >= h * minBand) {
        // 带内出现过近白像素的列范围
        const step = VSR.rowStep(gray), data = gray.data;
        let minX = -1, maxX = -1;
        for (let col = 0; col < w; col++) {
          let any = false;
          for (let row = paper.top; row <= paper.bottom; row++) {
            if (data[row * step + col] > C().PAPER_LEVEL) { any = true; break; }
          }
          if (any) {
            if (minX < 0) minX = col;
            maxX = col;
          }
        }
        if (minX >= 0) {
          const rect = {
            x: Math.max(0, minX - pad),
            y: Math.max(0, paper.top),
            w: Math.min(w, maxX + pad + 1) - Math.max(0, minX - pad),
            h: Math.min(h, paper.bottom + 1) - Math.max(0, paper.top),
          };
          return trimTrailingDark(gray, rect);
        }
      }
    }
    return null;
  }

  /**
   * 裁剪乐谱区域 + 上边界精修（返回独立 Mat，调用方 delete）
   * @param {cv.Mat} bgr BGR 帧
   * @param {{x,y,w,h}|null} rect
   * @returns {cv.Mat|null}
   */
  function cropScore(bgr, rect, topOffset, bottomOffset, leftOffset, rightOffset) {
    if (rect === null || rect === undefined) return null;
    topOffset = topOffset || 0; bottomOffset = bottomOffset || 0;
    leftOffset = leftOffset || 0; rightOffset = rightOffset || 0;
    let x1 = Math.max(0, rect.x + leftOffset);
    let y1 = Math.max(0, rect.y + topOffset);
    let x2 = Math.min(bgr.cols, rect.x + rect.w + rightOffset);
    let y2 = Math.min(bgr.rows, rect.y + rect.h + bottomOffset);
    if (x2 <= x1 || y2 <= y1) return null;
    const roi = bgr.rowRange(y1, y2).colRange(x1, x2);
    const refined = VSR.refineTopByProjection(roi);
    roi.delete();
    return refined;
  }

  VSR.looksLikeScore = looksLikeScore;
  VSR.trimTrailingDark = trimTrailingDark;
  VSR.findScoreRect = findScoreRect;
  VSR.cropScore = cropScore;
})();

console.log('[load] score_detect.js');
