// mp4box 解封装 + WebCodecs 顺序解码（语义对齐 Python imageio.imiter：
// 按呈现顺序逐帧回调、帧号从 0 计数；非采样帧由本模块 close）
//
// 依赖 lib/mp4box.all.min.js（UMD → 全局 MP4Box，importScripts 引入）
self.VSR = self.VSR || {};

(function () {
  /**
   * 从 mp4box trak 提取 AVCDecoderConfigurationRecord（VideoDecoderConfig.description）。
   * 优先用 avcC.data 原始字节；否则按 ISO 14496-15 用解析字段手工重组。
   */
  function avcDescription(trak) {
    try {
      const entries = (trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl
        && trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries) || [];
      const entry = entries.find((e) => e && (e.type === 'avc1' || e.type === 'avc3'))
        || entries[0];
      if (!entry) return null;
      const avcC = entry.avcC;
      if (!avcC) return null;
      const toU8 = (d) => d instanceof Uint8Array ? d
        : d instanceof ArrayBuffer ? new Uint8Array(d) : null;
      const raw = toU8(avcC.data);
      if (raw && raw.length) return raw;
      // mp4box 解析形态：SPS/PPS = [{length, nalu: Uint8Array}]，字段名 AVCProfileIndication
      const sps = (avcC.SPS || []).map((s) => toU8(s && s.nalu) || toU8(s)).filter(Boolean);
      const pps = (avcC.PPS || []).map((p) => toU8(p && p.nalu) || toU8(p)).filter(Boolean);
      if (!sps.length) return null;
      const lsm1 = (avcC.lengthSizeMinusOne === undefined ? 3 : avcC.lengthSizeMinusOne) & 3;
      const parts = [new Uint8Array([
        1,
        avcC.AVCProfileIndication !== undefined ? avcC.AVCProfileIndication : avcC.avcProfileIndication,
        avcC.profile_compatibility,
        avcC.AVCLevelIndication !== undefined ? avcC.AVCLevelIndication : avcC.avcLevelIndication,
        0xfc | lsm1,                             // 6bit reserved + lengthSizeMinusOne
        0xe0 | Math.min(31, sps.length),         // 3bit reserved + SPS count
      ])];
      const u16 = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
      for (const s of sps) { parts.push(u16(s.length), s); }
      parts.push(new Uint8Array([Math.min(255, pps.length)]));
      for (const p of pps) { parts.push(u16(p.length), p); }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    } catch (e) { /* 尝试性提取，失败返回 null */ }
    return null;
  }

  /**
   * 解析 mp4/碎片 mp4 的视频轨元信息（不解码）
   * @param {ArrayBuffer} buf
   * @returns {Promise<{fps:number, width:number, height:number, nbSamples:number, durationSec:number}>}
   */
  function probe(buf) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let done = false;
      file.onError = (e) => { if (!done) { done = true; reject(new Error('mp4box: ' + e)); } };
      file.onReady = (info) => {
        if (done) return;
        done = true;
        const vt = info.videoTracks && info.videoTracks[0];
        if (!vt) { reject(new Error('无视频轨')); return; }
        const durSec = info.duration / info.timescale;
        let fps = vt.fps;
        if (!fps || !isFinite(fps) || fps <= 0) {
          fps = durSec > 0 ? vt.nb_samples / durSec : 30;
        }
        resolve({
          fps,
          width: vt.video ? vt.video.width : 0,
          height: vt.video ? vt.video.height : 0,
          nbSamples: vt.nb_samples,
          durationSec: durSec,
          timescale: vt.timescale,
          codec: vt.codec || (vt.video && vt.video.codec) || null,
        });
      };
      try {
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush && file.flush();
      } catch (e) { reject(e); return; }
      setTimeout(() => {
        if (!done) { done = true; reject(new Error('mp4box: 未解析到 moov')); }
      }, 5000);
    });
  }

  /**
   * 顺序解码全片并按呈现帧号回调。
   *
   * output 回调保持同步（入队/关闭），消费由单泵串行 await，
   * 保证 onSample 不会并发交错（去重链是顺序敏感的）。
   *
   * @param {ArrayBuffer} buf 视频 .m4s / mp4 完整文件
   * @param {object} h 回调集：
   *   onMeta(meta)             解析完成后调用一次
   *   shouldSample(index)      每帧先问；true 才走 onSample
   *   onSample(frame, index)   可 async（串行执行，await 即背压）；用完自行 close
   *   onProgress(index, nb)    ~1% 节流
   *   shouldStop()             true 中止（取消），未消费帧会被关闭
   * @returns {Promise<{decoded:number, sampled:number}>}
   */
  async function decodeVideo(buf, h) {
    // ---- 1. 收集全部样本（decode order，data 为原缓冲视图）----
    const { all, meta } = await new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      const samples = [];
      let settled = false;
      file.onError = (e) => {
        if (!settled) { settled = true; reject(new Error('mp4box: ' + e)); }
      };
      file.onReady = (info) => {
        const vt = info.videoTracks && info.videoTracks[0];
        if (!vt) {
          if (!settled) { settled = true; reject(new Error('无视频轨')); }
          return;
        }
        file.setExtractionOptions(vt.id, null, { nbSamples: 120 });
        file.start();
        file.onSamples = (_id, _user, ss) => {
          for (const s of ss) samples.push(s);
        };
        // 先挂好 onSamples 再等 appendBuffer 返回后的 flush 收尾
        const durSec = info.duration / info.timescale;
        let fps = vt.fps;
        if (!fps || !isFinite(fps) || fps <= 0) {
          fps = durSec > 0 ? vt.nb_samples / durSec : 30;
        }
        const meta = {
          fps,
          width: vt.video ? vt.video.width : 0,
          height: vt.video ? vt.video.height : 0,
          nbSamples: vt.nb_samples,
          durationSec: durSec,
          timescale: vt.timescale,
          codec: vt.codec || (vt.video && vt.video.codec) || null,
          description: avcDescription(file.getTrackById(vt.id)),
        };
        file.__meta = meta;
      };
      try {
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush && file.flush();
      } catch (e) { reject(e); return; }
      if (!file.__meta) {
        reject(new Error('mp4box: 未解析到视频轨'));
        return;
      }
      if (!samples.length) { reject(new Error('mp4box: 无样本')); return; }
      const meta = file.__meta;
      meta.nbSamples = samples.length;
      settled = true;
      resolve({ all: samples, meta });
    });

    h.onMeta && h.onMeta(meta);
    if (!all.length) throw new Error('无样本可解码');

    // ---- 2. 顺序喂解码器 + 单泵串行消费 ----
    const pending = [];
    let index = 0;
    let sampled = 0;
    let lastPct = -1;
    let decodeErr = null;
    let feedingDone = false;
    let wake = null;
    const sleep = (ms) => new Promise((r) => {
      wake = r;
      setTimeout(r, ms === undefined ? 25 : ms);
    });
    const wakeAll = () => { if (wake) { const r = wake; wake = null; r(); } };

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (index === 0) console.log('[vsr] first frame out');
        if (decodeErr || (h.shouldStop && h.shouldStop())) { frame.close(); return; }
        const i = index++;
        if (h.shouldSample && !h.shouldSample(i)) { frame.close(); return; }
        pending.push({ frame, i });
        wakeAll();
      },
      error: (e) => { console.log('[vsr] decoder error: ' + e); decodeErr = e; wakeAll(); },
    });
    if (!meta.codec) throw new Error('mp4box: 无法获取视频 codec 字符串');
    console.log('[vsr] decoder cfg codec=' + meta.codec + ' desc=' +
      (meta.description ? meta.description.length : 'null') + ' ' + meta.width + 'x' + meta.height);
    decoder.configure({
      codec: meta.codec,
      // AVC 格式 H.264 必须带 avcC description（AVCDecoderConfigurationRecord）
      description: meta.description || undefined,
      codedWidth: meta.width || undefined,
      codedHeight: meta.height || undefined,
    });

    const waitNotFull = async () => {
      while (!decodeErr && (decoder.decodeQueueSize > 4 || pending.length > 3)) {
        if (h.shouldStop && h.shouldStop()) break;
        await sleep();
      }
    };

    const pump = async () => {
      for (;;) {
        if (pending.length) {
          const { frame, i } = pending.shift();
          if (h.shouldStop && h.shouldStop() || decodeErr) { frame.close(); continue; }
          try {
            sampled++;
            await h.onSample(frame, i);
          } catch (e) {
            try { frame.close(); } catch (_) {}
            decodeErr = decodeErr || e;
          }
          if (h.onProgress) {
            const pct = Math.floor(i / meta.nbSamples * 100);
            if (pct !== lastPct) { lastPct = pct; h.onProgress(i, meta.nbSamples); }
          }
          wakeAll();
          continue;
        }
        if (feedingDone && (!decoder || decoder.state === 'closed')) break;
        if (feedingDone && decodeErr) break;
        if (feedingDone) {
          // flush 后仍可能有尾帧在途：短暂等待，无帧即退出
          await sleep(15);
          if (!pending.length) break;
          continue;
        }
        await sleep();
      }
    };

    const pumpDone = pump();   // 常驻泵（空转等待入队）
    const tsScale = 1e6 / meta.timescale;
    try {
      for (const s of all) {
        if (decodeErr) break;
        if (h.shouldStop && h.shouldStop()) break;
        const chunk = new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(s.cts * tsScale),
          duration: Math.round(s.duration * tsScale),
          data: s.data,
        });
        decoder.decode(chunk);
        await waitNotFull();
      }
      console.log('[vsr] feed done, flushing; queue=' + decoder.decodeQueueSize);
      if (!decodeErr && !(h.shouldStop && h.shouldStop())) {
        await decoder.flush();
        console.log('[vsr] flush done');
      }
    } finally {
      try { if (decoder.state !== 'closed') decoder.close(); } catch (_) {}
      feedingDone = true;
      wakeAll();
    }
    // 泵排空 + 关闭残留帧
    await pumpDone;
    while (pending.length) pending.shift().frame.close();
    if (decodeErr) throw decodeErr;
    return { decoded: index, sampled, total: meta.nbSamples };
  }

  VSR.probeVideo = probe;
  VSR.decodeVideo = decodeVideo;
})();

console.log('[load] decode.js');
