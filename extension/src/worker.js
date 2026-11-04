// 流水线 worker：解码 → 检测/裁剪/去重 → 拼接（镜像 src/pipeline.py + video_io.py）
//
// 消息协议
//   → {cmd:'run', buffer:ArrayBuffer, params:{intervalSec, dedupThreshold, startTime, endTime}}
//   → {cmd:'cancel'}
//   ← {type:'progress', stage, progress, message}
//   ← {type:'done', segments:[{buffer,width,height,from,to}], meta, saved, skipped}
//   ← {type:'error', message}
importScripts(
  '../lib/opencv.js',
  '../lib/mp4box.all.min.js',
  'pipeline/constants.js',
  'pipeline/phasecorr.js',
  'pipeline/pic_clip.js',
  'pipeline/score_detect.js',
  'pipeline/dedup.js',
  'decode.js',
  'stitch.js'
);

// cv 是 Emscripten thenable：其 .then 返回值不可链，Promise.resolve/race 的
// assimilation 会引发微任务风暴。安全模式 = 单次 .then 进入，后续走原生链。
function whenCvReady(cb, onErr) {
  if (window.cv && typeof window.cv.then === 'function') window.cv.then(cb, onErr);
  else cb(window.cv);
}

let cancelRequested = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function progress(stage, p, message) {
  post({ type: 'progress', stage, progress: p, message: message || '' });
}

async function run(buffer, params) {
  cancelRequested = false;
  const intervalSec = params.intervalSec || VSR.CONST.DEFAULT_INTERVAL;
  const dedupThreshold = params.dedupThreshold !== undefined
    ? params.dedupThreshold : VSR.CONST.DEFAULT_DEDUP_THRESHOLD;

  progress('extract', 0, '解析视频流');
  let meta = null;
  let pastEnd = false;

  const dedup = new VSR.ImageDedup(dedupThreshold);
  const stitcher = new VSR.Stitcher();
  let saved = 0, skipped = 0;
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

  const canvas = new OffscreenCanvas(2, 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const result = await VSR.decodeVideo(buffer, {
    onMeta: (m) => {
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
      if (cancelRequested) { frame.close(); return; }
      const bmp = await createImageBitmap(frame);
      frame.close();
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // RGBA → BGR（流水线全部按 Python 的 BGR 语义）
      const bgr = new cv.Mat(canvas.height, canvas.width, cv.CV_8UC3);
      const d = bgr.data, s = img.data;
      for (let p = 0, q = 0; p < d.length; p += 3, q += 4) {
        d[p] = s[q + 2];
        d[p + 1] = s[q + 1];
        d[p + 2] = s[q];
      }
      const gray = new cv.Mat();
      cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
      const rect = VSR.findScoreRect(gray);
      gray.delete();
      const crop = VSR.cropScore(bgr, rect);
      bgr.delete();
      if (crop) {
        const { isNew } = dedup.add(crop);
        if (isNew) {
          await stitcher.add(crop, i);   // stitcher 内部 delete
          saved++;
        } else {
          crop.delete();
          skipped++;
        }
      }
      tick(i);
    },

    onProgress: () => {},   // 由 tick 节流上报
  });

  dedup.dispose();

  if (cancelRequested) {
    post({ type: 'error', message: '已取消' });
    return;
  }

  progress('stitch', 0.99, '拼接中');
  const st = await stitcher.finish();
  const segments = [];
  for (const seg of st.segments) {
    const ab = await seg.blob.arrayBuffer();
    segments.push({
      buffer: ab, width: seg.width, height: seg.height,
      from: seg.from, to: seg.to,
    });
  }
  progress('done', 1.0, `保存 ${saved} 张`);
  post({
    type: 'done',
    segments,
    meta: meta ? {
      fps: meta.fps, width: meta.width, height: meta.height,
      durationSec: meta.durationSec,
    } : null,
    saved, skipped, decoded: result ? result.decoded : 0,
  }, segments.map((s) => s.buffer));
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') {
    cancelRequested = true;
    return;
  }
  if (msg.cmd === 'run') {
    whenCvReady((cv) => {
      Promise.resolve().then(() => {
        if (!cv || !cv.Mat) throw new Error('OpenCV.js 初始化失败');
        return run(msg.buffer, msg.params || {});
      }).catch((err) => {
        post({ type: 'error', message: String(err && err.message || err) });
      });
    }, (e) => {
      post({ type: 'error', message: 'OpenCV 加载失败: ' + String(e && e.message || e) });
    });
  }
};
