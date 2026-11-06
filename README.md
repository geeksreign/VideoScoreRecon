# VideoScoreRecon 视频乐谱提取器

从视频（本地文件 / B 站 URL / B 站网页）中自动检测、裁剪滚动乐谱区域，
抽帧去重后纵向拼接为一张完整乐谱长图。

双运行时：

| 形态 | 说明 |
|---|---|
| **Python CLI / 本地服务** | `src/` — imageio + OpenCV 流水线，配浏览器扩展的"高级 HTTP 模式" |
| **Chrome 扩展（主推）** | `extension/` — 纯浏览器实现：WebCodecs 解码 + OpenCV.js 检测去重 + canvas 拼接，**全部处理在本机完成，不上传任何数据**（见 [extension/PRIVACY.md](extension/PRIVACY.md)） |

## 快速开始（Chrome 扩展，零配置）

1. `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录
2. 打开任意 B 站视频页（如 `https://www.bilibili.com/video/BV1jW41117JQ/`），点击右下角 **「🎼 提取乐谱」**
3. 填写时间范围（可空 = 全片），点「开始提取」→ 下载 → 抽帧 → 拼接 → 预览/下载 PNG

> 若页面右下角没有按钮：在 `chrome://extensions` 找到本扩展 → 「站点访问权限」→ 勾选「在所有站点上」。

## Python CLI（开发者）

```bash
uv sync
uv run python src/main.py --video <本地路径或B站URL> [--interval-sec 2.5] [--start-time 30 --end-time 120]
uv run pytest          # 43 例：检测/去重/拼接/任务队列
cd src && uv run python -m server   # 本地服务（扩展高级 HTTP 模式）
```

## 架构

```
Python（src/，参考实现与 oracle）              Chrome 扩展（extension/，产品形态）
┌──────────────────────────────┐          ┌──────────────────────────────────────┐
│ pipeline.py 编排              │          │ content.js  UI + 模式分流             │
│  ├ video_scrap/bili 下载      │          │ src/acquire.js  视频源双通道          │
│  ├ videocore/video_io 抽帧    │   对齐    │  ① playurl 画质默认480P ② 嗅探兜底   │
│  ├ score_detect/pic_clip 检测 │ ───────► │ src/worker.js  Worker 流水线          │
│  ├ dedup 相邻帧去重           │  fixtures │  ├ decode.js   mp4box+WebCodecs      │
│  └ stitch_scores 纵向拼接     │  40 例    │  ├ pipeline/   OpenCV.js 移植        │
│ server/ FastAPI（扩展 HTTP 模式）│          │  └ stitch.js   canvas 分段 PNG       │
└──────────────────────────────┘          └──────────────────────────────────────┘
```

- 两侧算法**同源语义**：`extension/src/pipeline/constants.js` 与 Python 各模块默认参数一一对应，
  任何一侧修改需同步另一侧
- **跨语言对齐测试**保证等价：`test/gen_fixtures.py`（Python oracle 生成期望）→ `extension/test/run.mjs`（headless Chrome 断言 37 例）

## 开发与测试

```bash
uv sync && uv run pytest              # Python 单测（43 例）

cd extension && npm install
npm test                              # 跨语言对齐 parity（37 例，需 Chrome）
node test/decode_run.mjs              # 端到端：真 worker 解码真视频 vs Python 期望
node test/page_ui.mjs                 # 扩展 UI 集成（chrome stub + mock acquire + 真 worker）
node test/extension_smoke.mjs         # 真站冒烟（需可加载扩展的 Chrome，见下）
```

### 真机手动验收（扩展注入，自动化受限于 Chrome 137+ 移除 `--load-extension`）

Chrome 137+ 的 headless/CDP 无法可靠加载 unpacked 扩展，真机注入请手动验收：

1. 按「快速开始」加载 `extension/`
2. 打开 B 站视频页 → 按钮出现 → 面板显示「本地引擎模式」
3. 一次完整提取：进度条走完 → 预览出现 → 下载 PNG 成功
4. （可选）设置页填 `baseUrl=http://127.0.0.1:8000` + Token → 走 Python 服务高级模式

> 扩展测试专用浏览器：`extension/.browsers/`（gitignore，`npx @puppeteer/browsers install
> chrome@124.0.6367.207 --path .browsers` 后执行 `xattr -dr com.apple.quarantine .browsers`）。

## 打包发布（Chrome Web Store）

```bash
cd extension && ./pack.sh     # 生成 dist/videoscore-<version>.zip（已排除测试文件）
```

上架材料：manifest（v1.0.0，单一用途"乐谱提取"）、图标 16/48/128、
隐私政策 `extension/PRIVACY.md`（数据零上传）、host_permissions 审核说明
（bilibili 页面注入 + 视频 CDN 拉流）。开发者账号注册费 $5 一次性。

## 目录结构

```
src/                  Python 流水线 + FastAPI 服务（参考实现）
extension/            Chrome 扩展（MV3，产品）
  manifest.json       权限：storage + bilibili/API/CDN host
  content.js          注入 UI，本地/HTTP 双模式分流
  editor.html|js|css  片段微调页（去重结果删/复制/排序/撤销 → 重新合并）
  src/acquire.js      视频源取流（默认480P: playurl 主取 / 嗅探兜底，设置页四档）
  src/worker.js       处理 Worker（解码→检测→去重→拼接）
  src/pipeline/       OpenCV.js 算法移植（与 src/videocore 同源语义）
  src/decode.js       mp4box 解封装 + WebCodecs 顺序解码
  src/stitch.js       canvas 纵拼 + 60000px 分段 PNG
  lib/                vendor：opencv.js 4.13、mp4box 0.5.4
  test/               parity / e2e / page_ui 测试与 fixtures
  icons/  pack.sh  PRIVACY.md
tests/                Python pytest（43 例）
test/                 Python 手工工具与 fixtures 生成器
data/                 运行数据（gitignore）
```

## 已知限制

- 仅支持白纸乐谱视频（阈值化检测，深色模式不支持）；参数按典型乐谱 App 调优
- 单段输出高度 >60000px 时自动分段（`score_..._p1.png`…）
- B 站 playurl 可能变更（WBI 签名未实现；现为主取路径，失败自动降级嗅探兜底可绕开 API 变动）
- 真机扩展注入的自动化受 Chrome 版本限制，见上方手动验收清单
