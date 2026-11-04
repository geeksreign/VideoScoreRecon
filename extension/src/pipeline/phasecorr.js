// 相位相关平移估计——数值镜像 cv2.phaseCorrelate（oracle: Python 端 cv2）
//
// OpenCV 的 JS 构建（官方 4.13 / @techstark）均未导出 phaseCorrelate，
// 这里按 imgproc/src/phasecorr.cpp 的 cv::phaseCorrelate 逐步实现：
//   1. 补零到 getOptimalDFTSize（2^a·3^b·5^c·7^d），窗口在原尺寸上乘、补零区为 0
//   2. FFT1/FFT2 → P = F1·conj(F2) → P/|P|（分母 + FLT_EPSILON）
//   3. IDFT（不缩放）取实部 → fftShift 象限交换
//   4. 峰值 + 5×5 加权重心（亚像素，框越界截断）
//   5. 返回 center - t，center = (补零宽/2, 补零高/2)
// 与 cv2 的唯一差异是浮点精度（OpenCV float32 / 这里 float64），
// parity 测试以真实 crop 对 + 合成平移对验证 (dx, dy) 与去重判定一致。
self.VSR = self.VSR || {};

(function () {
  // ---- cv::getOptimalDFTSize：最小的 2^a·3^b·5^c·7^d >= n ----
  const OPTIMAL = (() => {
    const set = new Set();
    for (let a = 0; (1 << a) <= 1 << 24; a++) {
      const p2 = 1 << a;
      if (p2 > 1 << 24) break;
      for (let b = 0; Math.pow(3, b) <= 1 << 24; b++) {
        const p3 = Math.pow(3, b);
        for (let c = 0; Math.pow(5, c) <= 1 << 24; c++) {
          const p5 = Math.pow(5, c);
          for (let d = 0; Math.pow(7, d) <= 1 << 24; d++) {
            const v = p2 * p3 * p5 * Math.pow(7, d);
            if (v <= 1 << 24) set.add(v);
          }
        }
      }
    }
    return Array.from(set).sort((x, y) => x - y);
  })();

  function getOptimalDFTSize(n) {
    if (n <= 1) return 1;
    let lo = 0, hi = OPTIMAL.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (OPTIMAL[mid] < n) lo = mid + 1; else hi = mid;
    }
    return lo < OPTIMAL.length ? OPTIMAL[lo] : -1;
  }

  // ---- radix-2 复数 FFT（就地）----
  function fft1(re, im, n, inverse) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + half] * cr - im[i + k + half] * ci;
          const vi = re[i + k + half] * ci + im[i + k + half] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // 只支持 2 的幂（补零尺寸是 getOptimalDFTSize，含 3/5/7 因子 → 用 Bluestein 不现实；
  // 这里对非 2 幂尺寸退化为按行/列分块… 不行。策略：内部再补到 2 幂做 FFT。
  // 线性相关的峰值位置与 DFT 长度无关（只要补零足够），因此外层保持
  // getOptimalDFTSize 的补零区域语义，FFT 计算继续补到 2 幂。
  function fft2(re, im, w, h, inverse) {
    // 行（w 必须是 2 幂，由 phaseCorrelate 的 pow2 补零保证）
    if (pow2(w) !== w) throw new Error('fft2: width must be power of 2');
    for (let y = 0; y < h; y++) {
      const off = y * w;
      fft1(re.subarray(off, off + w), im.subarray(off, off + w), w, inverse);
    }
    // 列
    if (pow2(h) !== h) throw new Error('fft2: height must be power of 2');
    const colRe = new Float64Array(h), colIm = new Float64Array(h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) { colRe[y] = re[y * w + x]; colIm[y] = im[y * w + x]; }
      fft1(colRe, colIm, h, inverse);
      for (let y = 0; y < h; y++) { re[y * w + x] = colRe[y]; im[y * w + x] = colIm[y]; }
    }
  }

  function pow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  // cv::createHanningWindow：一维 Hann 外积（系数 2π/(n-1)）
  function hanning2D(w, h) {
    const hx = new Float64Array(w), hy = new Float64Array(h);
    for (let i = 0; i < w; i++) hx[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (w - 1));
    for (let i = 0; i < h; i++) hy[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (h - 1));
    const win = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) win[y * w + x] = hy[y] * hx[x];
    return win;
  }

  // cv::fftShift 象限交换（2D 分支，含奇数维的 tmp 映射，逻辑照抄 phasecorr.cpp）
  function fftShiftReal(src, rows, cols) {
    const dst = new Float64Array(rows * cols);
    const xMid = cols >> 1, yMid = rows >> 1;
    const isXodd = (cols % 2) === 1, isYodd = (rows % 2) === 1;
    const blk = (r0, c0, hh, ww) => {
      const buf = new Float64Array(hh * ww);
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < ww; x++) buf[y * ww + x] = src[(r0 + y) * cols + (c0 + x)];
      return buf;
    };
    const put = (r0, c0, hh, ww, buf) => {
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < ww; x++) dst[(r0 + y) * cols + (c0 + x)] = buf[y * ww + x];
    };
    if (!isXodd && !isYodd) {
      // 偶×偶：q0↔q3, q1↔q2
      const q0 = blk(0, 0, yMid, xMid);
      const q1 = blk(0, xMid, yMid, xMid);
      const q2 = blk(yMid, 0, yMid, xMid);
      const q3 = blk(yMid, xMid, yMid, xMid);
      put(0, 0, yMid, xMid, q3);
      put(yMid, xMid, yMid, xMid, q0);
      put(0, xMid, yMid, xMid, q2);
      put(yMid, 0, yMid, xMid, q1);
    } else {
      // 奇数维分支（tmp0..tmp3 映射，照抄 phasecorr.cpp else 分支）
      const hwX = xMid + (isXodd ? 1 : 0), hwY = yMid + (isYodd ? 1 : 0);
      const q0 = blk(0, 0, hwY, hwX);
      const q1 = blk(0, hwX, yMid, xMid);
      const q2 = blk(hwY, 0, yMid, hwX);
      const q3 = blk(hwY, hwX, yMid, xMid);
      put(yMid, xMid, hwY, hwX, q0);   // tmp0 → (xMid, yMid)
      put(0, 0, yMid, xMid, q3);       // tmp3 → (0, 0)
      put(0, xMid, yMid, hwX, q1);     // tmp1 → (xMid, 0)
      put(hwY, 0, hwY, xMid, q2);      // tmp2 → (0, yMid)
    }
    return dst;
  }

  /**
   * 估计 mov 相对 ref 的平移 (dx, dy)，与 cv2.phaseCorrelate(ref, mov, window) 对齐。
   *
   * @param {Float32Array|Float64Array} ref 行主序 w*h（未乘窗）
   * @param {Float32Array|Float64Array} mov 行主序 w*h（未乘窗）
   * @param {number} w
   * @param {number} h
   * @returns {{dx:number, dy:number, response:number}}
   */
  function phaseCorrelate(ref, mov, w, h) {
    const M = getOptimalDFTSize(h);   // 补零后高
    const N = getOptimalDFTSize(w);   // 补零后宽
    const pw = pow2(N), ph = pow2(M); // FFT 计算尺寸（2 幂）
    const win = hanning2D(w, h);

    const n = pw * ph;
    const ar = new Float64Array(n), ai = new Float64Array(n);
    const br = new Float64Array(n), bi = new Float64Array(n);
    // 原尺寸窗乘 + 双层补零（getOptimalDFTSize 区域与更外层 2 幂区域均为 0）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = win[y * w + x];
        ar[y * pw + x] = ref[y * w + x] * v;
        br[y * pw + x] = mov[y * w + x] * v;
      }
    }
    fft2(ar, ai, pw, ph, false);
    fft2(br, bi, pw, ph, false);
    // P = F_ref * conj(F_mov)，归一化（分母 + FLT_EPSILON，对齐 divSpectrums）
    const EPS = 1.19209290e-7; // FLT_EPSILON
    for (let i = 0; i < n; i++) {
      const pr = ar[i] * br[i] + ai[i] * bi[i];
      const pi = ai[i] * br[i] - ar[i] * bi[i];
      const mag = Math.hypot(pr, pi) + EPS;
      ar[i] = pr / mag; ai[i] = pi / mag;
    }
    // IDFT（不缩放）→ 实部
    fft2(ar, ai, pw, ph, true);
    // 把 pw×ph 的线性相关面映射到 OpenCV 语义的 M×N 循环相关面：
    // OpenCV 在 M×N 上直接做循环相关，索引 i 对应 lag = i（i <= size/2）
    // 或 i - size（负 lag）。线性相关里负 lag 存在数组尾部（pw + lag）。
    const corr = new Float64Array(M * N);
    const lagIdx = (i, size) => (i <= size / 2 ? i : i - size);
    for (let y = 0; y < M; y++) {
      const ly = lagIdx(y, M);
      const sy = ly >= 0 ? ly : ph + ly;
      for (let x = 0; x < N; x++) {
        const lx = lagIdx(x, N);
        const sx = lx >= 0 ? lx : pw + lx;
        corr[y * N + x] = ar[sy * pw + sx];
      }
    }

    // fftShift（照抄 OpenCV 象限交换）
    const shifted = fftShiftReal(corr, M, N);

    // 峰值（minMaxLoc：行主序首个最大值）
    let best = -Infinity, px = 0, py = 0;
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < N; x++) {
        const v = shifted[y * N + x];
        if (v > best) { best = v; px = x; py = y; }
      }
    }
    // 5×5 加权重心（weightedCentroid，越界截断；权重为相关值）
    let minc = Math.max(0, px - 2), maxc = Math.min(N - 1, px + 2);
    let minr = Math.max(0, py - 2), maxr = Math.min(M - 1, py + 2);
    let cx = 0, cy = 0, sum = 0;
    for (let y = minr; y <= maxr; y++) {
      for (let x = minc; x <= maxc; x++) {
        const v = shifted[y * N + x];
        cx += x * v; cy += y * v; sum += v;
      }
    }
    sum += 2.220446049250313e-16; // DBL_EPSILON
    cx /= sum; cy /= sum;
    // 返回 center - t（center 用补零后 M×N 的一半，可为 .5）
    return { dx: N / 2.0 - cx, dy: M / 2.0 - cy, response: best };
  }

  VSR.phaseCorrelate = phaseCorrelate;
  VSR.getOptimalDFTSize = getOptimalDFTSize;
  VSR.hanning2D = hanning2D;
})();

console.log('[load] phasecorr.js');
