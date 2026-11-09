// 流水线常量——必须与 Python 侧同源：
//   src/videocore/score_detect.py、pic_clip.py、dedup.py 的默认参数
// 修改任一侧时同步另一侧，parity 测试会以此为契约。
self.VSR = self.VSR || {};

VSR.CONST = Object.freeze({
  // score_detect.find_score_rect
  DETECT_THRESH: 200,
  MIN_W_RATIO: 0.5,
  MIN_H_RATIO: 0.08,
  TOP_RATIO: 0.18,
  BOTTOM_RATIO: 0.35,
  PAD: 6,
  MIN_BAND_RATIO: 0.125,
  // score_detect._looks_like_score
  MIN_DARK: 0.002,
  MAX_DARK: 0.15,
  DARK_LEVEL: 150,          // 灰度 < 该值计为“暗”
  // score_detect._trim_trailing_dark
  MIN_WHITE_TRIM: 0.3,
  // pic_clip.find_paper_band
  PAPER_FRAC: 0.9,
  PAPER_RUN: 6,
  PAPER_LEVEL: 200,
  // pic_clip.refine_top_by_projection
  REFINE_LEVEL: 150,
  REFINE_RATIO: 0.005,      // max(w * 0.005, 2)
  REFINE_GUARD: 0.30,
  REFINE_MARGIN: 2,
  // dedup
  BLUE_THRESH: 40,
  BINARY_THRESH: 100,
  FILL_BGR: [211, 213, 227],
  MAX_SHIFT: 30,
  DEDUP_EPS: 2,             // margin = int(max(|dx|,|dy|)) + 2
  // 编排（video_io.extract_and_crop / pipeline.run_pipeline）
  DEFAULT_INTERVAL: 2.5,
  DEFAULT_DEDUP_THRESHOLD: 0.01,
  // worker 编排（非 Python 契约）：检测/去重统一工作宽度。
  // 852 对齐 Python 480p 基线与本目录 parity fixture；源宽 <= 852 时不放大。
  // 保留帧仍按源分辨率裁剪，输出画质不受影响。
  WORK_MAX_WIDTH: 852,
});

console.log('[load] constants.js');

// 官方 opencv.js 将 Mat.step 导出为 [行字节步长, 1] 数组而非数字，
// 直接 y*step 会得 NaN（数据写不进 Mat）。统一经此 helper 取行步长。
VSR.rowStep = function (mat) {
  return typeof mat.step === 'number' ? mat.step : mat.step[0];
};
