# AGENTS.md

Early-stage uv-managed Python app (Python 3.12) for detecting/cropping musical score regions from video. Git repo has no commits yet; no tests, lint, CI, or formatter config exists.

## Commands
- `uv sync` — install deps. Required before running anything: `opencv-python` is in the `dev` dependency group, not runtime deps.
- `python src/main.py --video <路径或B站URL> [--data-dir data] ...` — CLI pipeline (URL download → extract → crop → dedup → stitch). Both `src/main.py` and `src/pipeline.py` insert `src/videocore` and `src/video_scrap/bili` into `sys.path`, so they run from any CWD.
- `cd src && python -m server` — starts the local FastAPI service (http://127.0.0.1:8000) for the browser extension. Prints a per-run `Token` on startup; all `/api/*` except `/api/health` require `X-Auth-Token`. Env: `SCORE_SERVER_TOKEN` to pin the token, `SCORE_DATA_DIR` for the data root.
- Browser extension lives in `extension/` (MV3). Load unpacked via `chrome://extensions` (developer mode). Point it at the local service + paste the token in its options page; `content.js` runs on `https://www.bilibili.com/video/*`.

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
