// 乐谱纵向拼接（canvas 实现，镜像 video_io.stitch_scores，另加分段：
// Chrome canvas 单边上限 ~65535px，超限自动切 res_p1.png / res_p2.png…）
self.VSR = self.VSR || {};

(function () {
  const SEG_MAX_HEIGHT = 60000;   // < 65535 安全线

  class Stitcher {
    constructor() {
      /** @type {{canvas: OffscreenCanvas, ctx: CanvasRenderingContext2D, from: number, to: number}[]} */
      this.segments = [];
      this.cur = null;
      this.maxW = 0;
      this.cursorY = 0;
      this.frames = 0;
      this.fromFrame = -1;
    }

    _newSegment() {
      const canvas = new OffscreenCanvas(Math.max(1, this.maxW), SEG_MAX_HEIGHT);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.cur = { canvas, ctx, from: this.fromFrame, to: this.fromFrame, usedH: 0 };
    }

    /**
     * 追加一张裁剪图（BGR cv.Mat），所有权归本方法（内部删除）
     * 高度将超段上限时先封段。
     * @param {cv.Mat} cropBGR
     * @param {number} frameNo
     */
    async add(cropBGR, frameNo) {
      const w = cropBGR.cols, h = cropBGR.rows;
      if (this.frames === 0) this.fromFrame = frameNo;
      // 段宽不足 → 封当前段重开（段内宽对齐语义：后段独立取宽）
      if (this.cur && w > this.maxW) {
        // 已绘内容按段宽拉伸不变（Python 是全图统一 max 宽；分段后段内统一）
        await this._seal();
        this.maxW = w;
        this._newSegment();
      } else if (!this.cur) {
        this.maxW = w;
        this._newSegment();
      }
      if (this.cur.usedH + h > SEG_MAX_HEIGHT) {
        await this._seal();
        this.maxW = w;
        this._newSegment();
      }
      // BGR Mat → RGBA ImageData → Bitmap 绘制
      const rgba = new Uint8ClampedArray(w * h * 4);
      const step = VSR.rowStep(cropBGR), d = cropBGR.data;
      for (let y = 0; y < h; y++) {
        const off = y * step;
        for (let x = 0; x < w; x++) {
          const s = off + x * 3, t = (y * w + x) * 4;
          rgba[t] = d[s + 2];
          rgba[t + 1] = d[s + 1];
          rgba[t + 2] = d[s];
          rgba[t + 3] = 255;
        }
      }
      cropBGR.delete();
      const imgData = new ImageData(rgba, w, h);
      const bmp = await createImageBitmap(imgData);
      // 宽不等 → 按段宽拉伸（镜像 cv2.resize(i, (segW, h))）
      this.cur.ctx.drawImage(bmp, 0, this.cur.usedH, w, h);
      bmp.close();
      this.cur.usedH += h;
      this.cur.to = frameNo;
      this.frames++;
    }

    async _seal() {
      if (!this.cur) return;
      const { canvas, usedH, from, to } = this.cur;
      // OffscreenCanvas 调小尺寸会清空内容 → 复制已绘区域到精确高度的画布
      const final = new OffscreenCanvas(canvas.width, Math.max(1, usedH));
      const x2 = final.getContext('2d');
      x2.fillStyle = '#ffffff';
      x2.fillRect(0, 0, final.width, final.height);
      x2.drawImage(canvas, 0, 0);
      const blob = await final.convertToBlob({ type: 'image/png' });
      this.segments.push({ blob, width: final.width, height: final.height, from, to });
      this.cur = null;
    }

    /** @returns {Promise<{segments: Array<{blob,width,height,from,to}>, frames: number, fromFrame: number}>} */
    async finish() {
      await this._seal();
      return {
        segments: this.segments,
        frames: this.frames,
        fromFrame: this.fromFrame,
      };
    }
  }

  VSR.Stitcher = Stitcher;
})();

console.log('[load] stitch.js');
