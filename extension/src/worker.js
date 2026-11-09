// 流水线 worker：解码 → 检测/裁剪/去重 → 拼接（镜像 src/pipeline.py + video_io.py）
//
// 消息协议
//   → {cmd:'run', buffer:ArrayBuffer, params:{intervalSec, dedupThreshold, startTime, endTime}}
//   → {cmd:'cancel'}
//   ← {type:'progress', stage, progress, message}
//   ← {type:'done', segments:[{buffer,width,height,from,to}], meta, saved, skipped}
//   ← {type:'error', message}
console.log('[vsr] worker script start');
importScripts('../lib/opencv.js');
console.log('[vsr] imp opencv done');
importScripts('../lib/mp4box.all.min.js');
console.log('[vsr] imp mp4box done');
importScripts(
  'pipeline/constants.js',
  'pipeline/phasecorr.js',
  'pipeline/pic_clip.js',
  'pipeline/score_detect.js',
  'pipeline/dedup.js',
  'decode.js',
  'stitch.js'
);
console.log('[vsr] imp rest done');

console.log('[vsr] scripts loaded; cv=' + typeof cv + ' cvThen=' +
  (typeof cv !== 'undefined' && cv && typeof cv.then === 'function'));

// cv 是 Emscripten thenable：其 .then 返回值不可链，Promise.resolve/race 的
// assimilation 会引发微任务风暴。安全模式 = 单次 .then 进入，后续走原生链。
function whenCvReady(cb, onErr) {
  // worker 环境无 window，用 globalThis（opencv.js UMD 的 worker 分支挂到 self）
  const g = globalThis;
  if (g.cv && typeof g.cv.then === 'function') g.cv.then(cb, onErr);
  else cb(g.cv);
}

let cancelRequested = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

// 全局兜底：promise 内的异步异常不会触发外部 worker.onerror，
// 只发 unhandledrejection/error 到本 worker —— 在此转成 error 消息并带栈定位
self.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const detail = (r && (r.stack || r.message)) || String(r);
  post({ type: 'error', message: 'unhandledrejection: ' + detail });
});
self.addEventListener('error', (e) => {
  const where = e.filename ? ` @${String(e.filename).slice(-90)}:${e.lineno}:${e.colno}` : '';
  post({ type: 'error', message: (e.message || 'worker error') + where });
});

function progress(stage, p, message) {
  post({ type: 'progress', stage, progress: p, message: message || '' });
}

/**
 * BGR Mat → PNG 字节（去重保留帧的“可编辑片段”载体：无损、体积小、
 * 无 Mat 行步长/跨上下文序列化问题）
 * @param {cv.Mat} mat CV_8UC3
 * @returns {Promise<ArrayBuffer>}
 */
async function matToPng(mat) {
  const w = mat.cols, h = mat.rows;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const step = VSR.rowStep(mat), d = mat.data;
  for (let y = 0; y < h; y++) {
    const off = y * step;
    for (let x = 0; x < w; x++) {
      const s = off + x * 3, t = (y * w + x) * 4;
      rgba[t] = d[s + 2]; rgba[t + 1] = d[s + 1]; rgba[t + 2] = d[s]; rgba[t + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

/**
 * ImageData(RGBA) → BGR Mat（流水线统一按 Python 的 BGR 语义）
 * @param {ImageData} img
 * @returns {cv.Mat} CV_8UC3（调用方负责 delete）
 */
function rgbaToBgrMat(img) {
  const w = img.width, h = img.height, s = img.data;
  const bgr = new cv.Mat(h, w, cv.CV_8UC3);
  const d = bgr.data;
  for (let p = 0, q = 0; p < d.length; p += 3, q += 4) {
    d[p] = s[q + 2];
    d[p + 1] = s[q + 1];
    d[p + 2] = s[q];
  }
  return bgr;
}

/**
 * 工作分辨率 rect → 源分辨率 rect（四舍五入 + clamp 到 [0,gw]×[0,gh]）
 * @param {{x,y,w,h}} rect
 * @param {number} sx 源宽/工作宽
 * @param {number} sy 源高/工作高
 */
function scaleRect(rect, sx, sy, gw, gh) {
  const x = Math.max(0, Math.round(rect.x * sx));
  const y = Math.max(0, Math.round(rect.y * sy));
  const w = Math.max(1, Math.round(rect.w * sx));
  const h = Math.max(1, Math.round(rect.h * sy));
  return {
    x, y,
    w: Math.min(gw, x + w) - x,
    h: Math.min(gh, y + h) - y,
  };
}

/**
 * Stitcher 封段 → done 消息载荷（run 与编辑器 restitch 共用）
 * @returns {Promise<{segments: Array<{buffer,width,height,from,to}>, transfer: ArrayBuffer[]}>}
 */
async function segmentsToPayload(stitcher) {
  const st = await stitcher.finish();
  const segments = [];
  for (const seg of st.segments) {
    const ab = await seg.blob.arrayBuffer();
    segments.push({
      buffer: ab, width: seg.width, height: seg.height,
      from: seg.from, to: seg.to,
    });
  }
  return { segments, transfer: segments.map((s) => s.buffer) };
}

async function run(buffer, params) {
  cancelRequested = false;
  const intervalSec = params.intervalSec || VSR.CONST.DEFAULT_INTERVAL;
  const dedupThreshold = params.dedupThreshold !== undefined
    ? params.dedupThreshold : VSR.CONST.DEFAULT_DEDUP_THRESHOLD;

  progress('extract', 0, '解析视频流');
  let meta = null;
  let pastEnd = false;
  let dbgSent = false;
  let dbgMidDone = false;

  const dedup = new VSR.ImageDedup(dedupThreshold);
  const stitcher = new VSR.Stitcher();
  let saved = 0, skipped = 0;
  const frameNos = [];           // 保留帧的帧号（对齐 Python crops/score_XXXXXX 命名）
  const keptCrops = [];          // 保留帧 PNG（编辑器微调合并用，done 一并带出）
  let startFrame = 0, endFrame = null, sampleStep = 1, totalFrames = null;
  let lastPct = -1;

  const sampleStepFor = (fps) => Math.max(1, Math.round(intervalSec * fps));

  const tick = (i, forceMsg) => {
    if (!totalFrames) return;
    const bucket = Math.max(1, Math.floor(totalFrames / 100));
    if (i % bucket !== 0 && !forceMsg) return;
    const pct = Math.floor(i / totalFrames * 100);
    if (pct === lastPct && !forceMsg) return;
    lastPct = pct;
    progress('extract', Math.min(1, i / totalFrames), forceMsg || `抽帧 ${i}/${totalFrames}`);
  };

  // 工作画布：检测/去重统一在固定工作分辨率上跑（WORK_MAX_WIDTH，源宽<=该值不放大）。
  // 全分辨率画布懒创建，仅在保留帧（约 6 张）与诊断帧上重建，输出仍保持源分辨率。
  const workCanvas = new OffscreenCanvas(2, 2);
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
  let fullCanvas = null, fullCtx = null;
  const ensureFullCanvas = (w, h) => {
    if (!fullCanvas) {
      fullCanvas = new OffscreenCanvas(w, h);
      fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    } else if (fullCanvas.width !== w || fullCanvas.height !== h) {
      fullCanvas.width = w;
      fullCanvas.height = h;
    }
  };

  const result = await VSR.decodeVideo(buffer, {
    onMeta: (m) => {
      // 碎片 mp4（B 站 .m4s）mvhd duration 常为 0：用 nbSamples/fps 回推，
      // 保证 totalFrames/endTime 语义与 Python（imageio 逐帧计数）一致
      if (!(m.durationSec > 0) && m.nbSamples > 0 && m.fps > 0) {
        m.durationSec = m.nbSamples / m.fps;
      }
      meta = m;
      sampleStep = sampleStepFor(m.fps);
      startFrame = params.startTime !== undefined && params.startTime !== null
        ? Math.max(0, Math.round(params.startTime * m.fps)) : 0;
      if (params.endTime !== undefined && params.endTime !== null) {
        if (params.endTime > m.durationSec) {
          endFrame = null;   // 超过视频时长 → 到结尾（同 Python）
        } else {
          endFrame = Math.round(params.endTime * m.fps);
        }
      }
      totalFrames = Math.round(m.durationSec * m.fps);
      console.log('[vsr] meta dur=' + m.durationSec + ' nb=' + m.nbSamples +
        ' fps=' + m.fps + ' totalFrames=' + totalFrames);
      if (endFrame !== null && startFrame >= endFrame) {
        throw new Error(`截取区间非法: start=${startFrame} >= end=${endFrame}`);
      }
      progress('extract', 0, `视频 ${m.width}x${m.height} @${m.fps.toFixed(2)}fps，步长 ${sampleStep} 帧`);
    },

    shouldSample: (i) => {
      if (cancelRequested) return false;
      if (i < startFrame) {
        // 跳至 start_time 阶段也上报进度（对齐 video_io.tick_progress）
        tick(i, `跳至 ${params.startTime}s: ${i}/${startFrame}`);
        return false;
      }
      if (endFrame !== null && i >= endFrame) { pastEnd = true; return false; }
      const sampleEnd = endFrame !== null ? endFrame : (meta ? meta.nbSamples : 0);
      const isLast = i === Math.max(startFrame, sampleEnd - 1);
      const onGrid = (i - startFrame) % sampleStep === 0;
      return onGrid || isLast;
    },

    shouldStop: () => cancelRequested || pastEnd,

    onSample: async (frame, i) => {
      if (i === 0) console.log('[vsr] onSample(0) enter');
      if (cancelRequested) { frame.close(); return; }
      const disp = [frame.displayWidth, frame.displayHeight];
      const coded = [frame.codedWidth, frame.codedHeight];
      const bmp = await createImageBitmap(frame);
      if (i === 0) console.log('[vsr] onSample(0) bitmap done');
      frame.close();
      // 栅格化尺寸对齐 track meta（Python imageio 输出口径）：本视频 SPS 显示
      // 853 而 tkhd 为 852，两解码栈差 1px——以 meta 为准，源裁剪不重采样。
      const gw = (meta && meta.width) ? meta.width : bmp.width;
      const gh = (meta && meta.height) ? meta.height : bmp.height;
      const sw = Math.min(bmp.width, gw), sh = Math.min(bmp.height, gh);
      // 工作分辨率：检测/去重固定宽度（源宽 <= WORK_MAX_WIDTH 时不放大）
      const workW = Math.min(gw, VSR.CONST.WORK_MAX_WIDTH);
      const workH = Math.max(1, Math.round(gh * workW / gw));
      const fullRes = (workW === gw && workH === gh);
      if (workCanvas.width !== workW || workCanvas.height !== workH) {
        workCanvas.width = workW;
        workCanvas.height = workH;
      }
      workCtx.drawImage(bmp, 0, 0, sw, sh, 0, 0, workW, workH);
      const workImg = workCtx.getImageData(0, 0, workW, workH);
      if (i === 0) console.log('[vsr] onSample(0) getImageData done');

      // 诊断图：帧0 + 过半首个抽帧 → dataURL 发宿主（排查 rect 全 null 用）
      const wantImg = i === 0
        || (i !== 0 && !dbgMidDone && meta && i >= meta.nbSamples / 2);
      if (wantImg) {
        if (i !== 0) dbgMidDone = true;
        try {
          ensureFullCanvas(gw, gh);
          fullCtx.drawImage(bmp, 0, 0, sw, sh, 0, 0, gw, gh);
          const blob = await fullCanvas.convertToBlob({ type: 'image/png' });
          const dataUrl = await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.readAsDataURL(blob);
          });
          post({ type: 'debugimg', i, dataUrl });
          console.log('[vsr] debugimg frame i=' + i);
        } catch (e) { console.log('[vsr] debugimg fail ' + e); }
      }
      if (!dbgSent) {
        dbgSent = true;
        post({
          type: 'debug', phase: 'frame0',
          bmp: [gw, gh], disp, coded,
          meta: meta ? [meta.width, meta.height] : null,
        });
      }

      // 检测/去重全部在 work 尺寸上做（RGBA → BGR，流水线统一 BGR 语义）
      const workBgr = rgbaToBgrMat(workImg);
      const gray = new cv.Mat();
      cv.cvtColor(workBgr, gray, cv.COLOR_BGR2GRAY);
      if (i === 0) console.log('[vsr] onSample(0) cvtColor done');
      const rect = VSR.findScoreRect(gray);
      gray.delete();
      if (i === 0) console.log('[vsr] onSample(0) findScoreRect done ' + JSON.stringify(rect));
      const workCrop = VSR.cropScore(workBgr, rect);
      if (i === 0) console.log('[vsr] onSample(0) cropScore done crop=' + (workCrop ? 'mat' : 'null'));
      workBgr.delete();
      if (i === 0) console.log('[vsr] onSample(0) bgr.delete done');
      if (workCrop) {
        const { isNew } = dedup.add(workCrop);
        if (i === 0) console.log('[vsr] onSample(0) dedup done isNew=' + isNew);
        if (isNew) {
          // 保留帧按源分辨率裁剪（work==full 时直接复用，省一次绘制）
          let fullCrop;
          if (fullRes) {
            fullCrop = workCrop;
          } else {
            ensureFullCanvas(gw, gh);
            fullCtx.drawImage(bmp, 0, 0, sw, sh, 0, 0, gw, gh);
            const fullImg = fullCtx.getImageData(0, 0, gw, gh);
            const fullBgr = rgbaToBgrMat(fullImg);
            fullCrop = VSR.cropScore(
              fullBgr, scaleRect(rect, gw / workW, gh / workH, gw, gh));
            fullBgr.delete();
            if (fullCrop) {
              workCrop.delete();
            } else {
              console.log('[vsr] 全分辨率裁剪为空 @' + i + '，回退工作分辨率');
              fullCrop = workCrop;
            }
          }
          // 进 stitcher（接管删除）之前先编码 PNG——编辑器“片段微调”的数据来源
          keptCrops.push({
            png: await matToPng(fullCrop), width: fullCrop.cols, height: fullCrop.rows, frame: i,
          });
          await stitcher.add(fullCrop, i);   // stitcher 内部 delete
          if (i === 0) console.log('[vsr] onSample(0) stitch done');
          saved++;
          frameNos.push(i);
        } else {
          workCrop.delete();
          skipped++;
        }
      }
      bmp.close();
      tick(i);
      if (i === 0) console.log('[vsr] onSample(0) tick done');
    },

    // decode.js 已按 ~1% 节流，直接作为解码期心跳进度（兜底 tick 漏报）
    onProgress: (i, nb) => progress('extract', Math.min(1, i / nb), `解码 ${i}/${nb}`),
  });

  dedup.dispose();

  if (cancelRequested) {
    post({ type: 'error', message: '已取消' });
    return;
  }

  progress('stitch', 0.99, '拼接中');
  const { segments, transfer } = await segmentsToPayload(stitcher);
  progress('done', 1.0, `保存 ${saved} 张`);
  post({
    type: 'done',
    segments,
    meta: meta ? {
      fps: meta.fps, width: meta.width, height: meta.height,
      durationSec: meta.durationSec,
    } : null,
    saved, skipped, frameNos, decoded: result ? result.decoded : 0,
    keptCrops,
  }, transfer.concat(keptCrops.map((c) => c.png)));
}

/**
 * 编辑器「重新合并」：给定已去重的 PNG 片段直接走 Stitcher——与产线 run()
 * 的合并语义逐像素一致（同一 VSR.Stitcher、同一顺序堆叠规则）
 * @param {Array<{png: ArrayBuffer, frame: number}>} crops
 */
async function restitch(crops) {
  cancelRequested = false;
  const n = crops.length;
  if (!n) { post({ type: 'error', message: '没有可合并的片段' }); return; }
  const stitcher = new VSR.Stitcher();
  for (let idx = 0; idx < n; idx++) {
    if (cancelRequested) { post({ type: 'error', message: '已取消' }); return; }
    const c = crops[idx];
    const bmp = await createImageBitmap(new Blob([c.png], { type: 'image/png' }));
    const w = bmp.width, h = bmp.height;
    const cvCanvas = new OffscreenCanvas(w, h);
    const ctx = cvCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    const mat = new cv.Mat(h, w, cv.CV_8UC3);
    const d = mat.data, s = img.data;
    for (let p = 0, q = 0; p < d.length; p += 3, q += 4) {
      d[p] = s[q + 2]; d[p + 1] = s[q + 1]; d[p + 2] = s[q];
    }
    await stitcher.add(mat, c.frame);   // stitcher 内部 delete
    post({ type: 'progress', stage: 'stitch', progress: (idx + 1) / n, message: `合并 ${idx + 1}/${n}` });
  }
  const { segments, transfer } = await segmentsToPayload(stitcher);
  post({
    type: 'done', segments,
    saved: n, skipped: 0, frameNos: crops.map((c) => c.frame),
  }, transfer);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') {
    cancelRequested = true;
    return;
  }
  if (msg.cmd === 'run') {
    console.log('[vsr] run cmd received');
    whenCvReady((cv) => {
      console.log('[vsr] cv ready, starting pipeline');
      Promise.resolve().then(() => {
        if (!cv || !cv.Mat) throw new Error('OpenCV.js 初始化失败');
        return run(msg.buffer, msg.params || {});
      }).catch((err) => {
        post({ type: 'error', message: String(err && err.message || err) });
      });
    }, (e) => {
      post({ type: 'error', message: 'OpenCV 加载失败: ' + String(e && e.message || e) });
    });
    return;
  }
  if (msg.cmd === 'stitch') {
    console.log('[vsr] stitch cmd received, crops=' + (msg.crops ? msg.crops.length : 0));
    whenCvReady((cv) => {
      Promise.resolve().then(() => {
        if (!cv || !cv.Mat) throw new Error('OpenCV.js 初始化失败');
        return restitch(msg.crops || []);
      }).catch((err) => {
        post({ type: 'error', message: String(err && err.message || err) });
      });
    }, (e) => {
      post({ type: 'error', message: 'OpenCV 加载失败: ' + String(e && e.message || e) });
    });
  }
};
