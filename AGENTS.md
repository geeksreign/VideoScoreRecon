# AGENTS.md

Early-stage uv-managed Python app (Python 3.12) for detecting/cropping musical score regions from video. Has an initial commit pushed to GitHub; `pytest` tests exist under `tests/`, but no lint, CI, or formatter config.

## Commands
- `uv sync` — install deps. Required before running anything (runtime deps include `opencv-python`).
- `uv run pytest` — run the test suite (`tests/`, configured via `[tool.pytest.ini_options]` in `pyproject.toml`).
- `python src/main.py --video <路径或B站URL> [--data-dir data] ...` — CLI pipeline (URL download → extract → crop → dedup → stitch). `--video` is required. Both `src/main.py` and `src/pipeline.py` insert `src/videocore` and `src/video_scrap/bili` into `sys.path`, so they run from any CWD.
- `cd src && python -m server` — starts the local FastAPI service (http://127.0.0.1:8000) for the browser extension. Prints a per-run `Token` on startup; all `/api/*` except `/api/health` require `X-Auth-Token`. Env: `SCORE_SERVER_TOKEN` to pin the token, `SCORE_DATA_DIR` for the data root.
- Browser extension lives in `extension/` (MV3). Load unpacked via `chrome://extensions` (developer mode). Point it at the local service + paste the token in its options page; `content.js` runs on `https://www.bilibili.com/video/*`.
- Extension tests (from `extension/`, needs `npm i`): `npm run test` (算法对齐 runner，与 Python fixture 逐帧哈希对比), `npm run test:acquire` (下载三层兜底单测), `npm run test:ui` (content 全链 UI 集成), `npm run test:editor` (片段微调页：编辑操作+真 worker 合并), `npm run test:smoke` (真站端到端，依赖 `.browsers/` 的 Chrome for Testing 124；`NO_EXTRACT=1` 只测注入, `SMOKE_BV=<BV>` 换视频)。

## Architecture
- `src/pipeline.py::run_pipeline(video_input, data_dir, ..., on_progress)` — shared orchestration used by both the CLI (`src/main.py`) and the server (`src/server/jobs.py`). `on_progress(stage, progress, message)` with stages `download/extract/stitch/done`; `video_io.extract_and_crop` reports progress via the same callback (throttled ~1%).
- `src/server/` — FastAPI app: `POST /api/extract` → `{job_id}`, `GET /api/progress/{job_id}`, `GET /api/result/{job_id}` (serves `final/res.png`). `jobs.py` is an in-memory JobStore with a single serial worker thread (one job at a time).

## Gotchas
- `src/videocore/*.py` use sibling imports (`from score_detect import ...`, `from pic_clip import ...`). Importing as `videocore.video_io` from `src/` fails with `ModuleNotFoundError`. Run them from inside `src/videocore/`, e.g. `cd src/videocore && python video_io.py`.
- `video_io.py` is now a library module (no CLI); the CLI lives in `src/main.py`. It organizes data per input video name under `data/<视频名>/`: `video/` (input, auto-moved here), `crops/` (deduped crops), `clusters/` (consecutive-run inspection), `final/res.png` (stitched result). Crops/clusters/final are cleaned before each run; `video/` is never touched. If the given `--video` path is missing it falls back to `<视频名>/video/<原名>`.
- `--video` also accepts a Bilibili URL (any `http(s)://`); the pipeline downloads it first via `src/video_scrap/bili/` into `data/<分P标题>/video/`. Only the first (guest) quality is guaranteed — up to 480p without login, higher with `--cookie SESSDATA`.
- `src/video_scrap/bili/*.py` also use sibling imports (`from api import ...`, `from download import ...`); `src/pipeline.py` inserts `../video_scrap/bili` into `sys.path`. Standalone: `cd src/video_scrap/bili && python main.py <url> -o out.mp4`.
- Bili download = sniff `x/player/playurl` DASH (`fnval=16`) → download video/audio `.m4s` → remux with `imageio_ffmpeg.get_ffmpeg_exe()` (`-c copy`). Requires a `Referer` header; the Bili API can change (may need WBI signing later).
- imageio FFMPEG returns RGB frames; OpenCV needs BGR — `video_io.py` converts with `cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)`.
- Code comments are in Chinese.
- `test_pic_exp.py` is an image-only crop test (uses `data/pic_exp/`, outputs to `data/pic_exp_out/`), independent of the video pipeline.
- `tests/` holds pytest tests (auto-discovered); `test/` holds manual utility scripts (`comp_similar_pics.py` reuses `videocore/dedup.py` core, so both share one dedup implementation).
- 扩展：页面源 content script `new Worker('chrome-extension://...')` 必抛 SecurityError（WAR 只放行 fetch），流水线 worker 经隐藏 iframe `worker_host.html`（扩展源）中转构造。
- 扩展：MV3 禁 `unsafe-eval`。`lib/opencv.js`（Emscripten/embind）已手工打 4 处无 eval 补丁：`createNamedFunction`、dynCall 蹦床、`craftInvokerFunction`（eval-free invoker 主路径）、`__emval_get_method_caller`——**升级/替换 opencv.js 必须重打**。manifest `content_security_policy.extension_pages` 必须是 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`（worker.js 响应头继承该值，缺 wasm 会拒绝编译；加 `'inline-speculation-rules'`/`localhost` 等源 Chrome 拒载 manifest）。
- 扩展：B 站碎片 `.m4s` 的 mvhd duration 可能为 0 → `worker.js` onMeta 用 `nbSamples/fps` 回推；解码进度心跳走 decode.js `onProgress`（抽帧 tick 的 `totalFrames` 依赖它）。下载分三层 `cred→nocred→background SW`（`acquire.js::fetchWithProgress`），全败后面板出「授权全网访问并重试」按钮（optional `*://*/*`）。
- `extension/.browsers/` 的 Chrome for Testing 124 若二进制只有 136KB/无 Frameworks 即下载残缺（`npx @puppeteer/browsers install` 解压有 bug）：`unzip -q .browsers/chrome/<ver>-chrome-mac-x64.zip -d .browsers/chrome/mac-<ver>` 手动解压。smoke 默认 `SMOKE_BV=BV1jW41117JQ`（真实动态谱视频；Rickroll MV 检测必然 0 检出）。
- parity fixture 覆盖要留意维度奇偶与输入形态：phasecorr `fftShiftReal` 奇数维分支曾坏（`getOptimalDFTSize(h)` 为奇如 170→175 时相关峰不移动 → 去重断链多留帧），而 37 个旧 fixture 的 DFT 尺寸全偶未暴露。`cases.json` 现有 `phasecorr_cases`（含奇数维 roll）与 `phase_pair_cases`（成对 pad-shift 输入，能红灯复现该 bug）两类，加算法 fixture 时两类形态都要想到。
