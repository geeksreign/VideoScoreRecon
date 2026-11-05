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
      if (canvas.width !== gw || canvas.height !== gh) {
        canvas.width = gw;
        canvas.height = gh;
      }
      const sw = Math.min(bmp.width, gw), sh = Math.min(bmp.height, gh);
      ctx.drawImage(bmp, 0, 0, sw, sh, 0, 0, gw, gh);
      bmp.close();
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (i === 0) console.log('[vsr] onSample(0) getImageData done');
      // 诊断图：帧0 + 过半首个抽帧 → dataURL 发宿主（排查 rect 全 null 用）
      const wantImg = i === 0
        || (i !== 0 && !dbgMidDone && meta && i >= meta.nbSamples / 2);
      if (wantImg) {
        if (i !== 0) dbgMidDone = true;
        try {
          const blob = await canvas.convertToBlob({ type: 'image/png' });
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
          bmp: [img.width, img.height], disp, coded,
          meta: meta ? [meta.width, meta.height] : null,
        });
      }

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
      if (i === 0) console.log('[vsr] onSample(0) cvtColor done');
      const rect = VSR.findScoreRect(gray);
      gray.delete();
      if (i === 0) console.log('[vsr] onSample(0) findScoreRect done ' + JSON.stringify(rect));
      const crop = VSR.cropScore(bgr, rect);
      if (i === 0) console.log('[vsr] onSample(0) cropScore done crop=' + (crop ? 'mat' : 'null'));
      bgr.delete();
      if (i === 0) console.log('[vsr] onSample(0) bgr.delete done');
      if (crop) {
        const { isNew } = dedup.add(crop);
        if (i === 0) console.log('[vsr] onSample(0) dedup done isNew=' + isNew);
        if (isNew) {
          await stitcher.add(crop, i);   // stitcher 内部 delete
          if (i === 0) console.log('[vsr] onSample(0) stitch done');
          saved++;
          frameNos.push(i);
        } else {
          crop.delete();
          skipped++;
        }
      }
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
    saved, skipped, frameNos, decoded: result ? result.decoded : 0,
  }, segments.map((s) => s.buffer));
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
  }
};
