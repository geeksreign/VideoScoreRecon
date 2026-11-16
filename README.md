# 视频乐谱提取器（VideoScoreRecon）

从视频（本地文件 / B 站 URL / YouTube URL）中自动检测、裁剪滚动乐谱区域，
抽帧去重后纵向拼接为一张完整乐谱长图，供个人学习参考。

双形态（本分支为 dev 开发版，Python 为主、扩展为辅）：

| 形态 | 说明 |
|---|---|
| **Python CLI / 本地服务** | `src/` — imageio + OpenCV 流水线：下载 → 抽帧 → 检测裁剪 → 去重 → 拼接；可选 FastAPI 本地服务（供扩展调用） |
| **Chrome 扩展 0.1.0** | `extension/` — B 站视频页薄客户端：页面内按钮/面板，经 `http://127.0.0.1:8000` 调用本地服务完成提取 |

> 扩展的现代完整版（i18n、微调页、画质设置、扩展内取流等）在独立私有仓库 **`VideoScoreRecon-ext`** 维护；本分支的扩展仅作 Python 流水线的浏览器前端。

## 快速开始（Python CLI）

```bash
uv sync                 # 安装依赖（含 opencv-python / yt-dlp）
uv run python src/main.py --video <本地路径|B站URL|YouTubeURL>
```

常用选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--video` | 必填 | 本地视频路径、B 站 URL 或 YouTube URL（含 `youtu.be` 短链） |
| `--interval-sec` | 3 | 抽帧间隔秒数 |
| `--dedup-threshold` | 0.01 | 曲谱骨架差异占比阈值（相邻帧差异 ≤ 该值视为重复） |
| `--start-time / --end-time` | 全片 | 截取区间（秒或 `mm:ss` / `hh:mm:ss`） |
| `--cookie` | 无 | B 站登录 Cookie（SESSDATA），仅 B 站 URL 时生效，提升可用画质 |
| `--no-stitch` | 关 | 跳过最终拼接（只看裁剪与去重中间结果） |
| `--data-dir` | `<repo>/data` | 数据根目录 |

一次完整运行的输出位于 `data/<视频名>/`：

```
data/<视频名>/
├── video/      输入视频（自动移入，重跑不清除）
├── crops/      去重后的裁剪图 score_<帧号>.jpg
├── clusters/   连续重复段核验中间状态
└── final/res.png   拼接结果（PNG 长图）
```

> `crops/`、`clusters/`、`final/` 每次运行前自动清理重建；`video/` 不动。
> 若 `--video` 指定的路径不存在，会回退查找 `data/<视频名>/video/<原名>`。

## 本地服务（FastAPI，供浏览器扩展调用）

```bash
cd src && uv run python -m server     # http://127.0.0.1:8000
```

- 仅监听 `127.0.0.1`，启动时打印本次运行的 **Token**；除 `/api/health` 外所有接口需携带
  `X-Auth-Token` 请求头。
- 环境变量：`SCORE_SERVER_TOKEN` 固定 token；`SCORE_DATA_DIR` 指定数据根目录（默认仓库 `data/`）。

| 接口 | 说明 |
|---|---|
| `POST /api/extract` | 提交提取任务 `{url, start_time?, end_time?, interval_sec, dedup_threshold, cookie?}` → `{job_id}` |
| `GET /api/progress/{job_id}` | 任务状态（stage/progress/message；cookie 不回传） |
| `GET /api/result/{job_id}` | 完成取出结果图（`final/res.png`） |

任务在内存 `JobStore` 中排队，由单 worker 线程串行处理（一次一个任务，最多保留 100 条）。

## Chrome 扩展（0.1.0，需配合本地服务）

1. `chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」→ 选择 `extension/`
2. 右键图标 →「选项」→ 填写 `baseUrl`（默认 `http://127.0.0.1:8000`）与上一步启动服务打印的 Token
   （可选填 B 站 SESSDATA Cookie 提画质）
3. 打开任意 B 站视频页（`https://www.bilibili.com/video/*`），点右下角「🎼 提取乐谱」：
   填写时间范围（可空 = 全片）、抽帧间隔、去重阈值 →「开始提取」→ 进度条 → 预览 → 保存 PNG

扩展自身只做请求转发与结果下载，全部检测/裁剪/去重/拼接由本地服务完成。

## 视频源

| 来源 | 实现 | 说明 |
|---|---|---|
| **B 站 URL** | `src/video_scrap/bili/` | 嗅探 `x/player/playurl` DASH（`fnval=16`）→ 并行下载视频/音频 `.m4s` → 用 imageio-ffmpeg 自带 ffmpeg 无损混流为 mp4（带 `Referer` 头）。游客画质有限、不保证；`--cookie SESSDATA` 解锁更高 |
| **YouTube URL** | `src/video_scrap/ytdlp/` | yt-dlp 下载并合并音视频，优选 H.264 + mp4（保证 OpenCV/imageio 可解码），`ffmpeg_location` 直接指向 imageio-ffmpeg 二进制。公共视频无需登录；会员专享视频不可下载；支持 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量代理 |

URL 分流在 `src/pipeline.py::_is_youtube_url`：主机为 `youtube.com` / `youtu.be` /
`youtube-nocookie.com` 走 ytdlp 分支，其余 URL（含 B 站）走 bili 分支；本地路径不下载。

## 架构

`src/pipeline.py::run_pipeline` 是 CLI 与本地服务共享的编排入口，阶段回调
`on_progress(stage, progress, message)`，stage ∈ `download / extract / stitch / done`：

```
run_pipeline（pipeline.py）
 ├─ [URL] 分流下载
 │   ├─ B 站：video_scrap/bili    playurl 嗅探 + .m4s 下载 + ffmpeg 混流
 │   └─ YouTube：video_scrap/ytdlp yt-dlp 下载（H.264/mp4）
 ├─ video_io.extract_and_crop
 │   ├─ imageio FFMPEG 逐帧读取 → RGB，cv2.cvtColor 转 BGR
 │   ├─ 按真实帧率抽帧（区间起点对齐 + 末尾补采）
 │   ├─ score_detect / pic_clip 检测并裁剪乐谱区域
 │   ├─ dedup 相邻帧曲谱骨架比对去重（写 clusters 核验段）
 │   └─ stitch_scores 数字序纵拼 → final/res.png
 └─ server/jobs.py 包装为串行任务队列（单 worker）
```

两侧算法参数与注释对应扩展的人口移植实现（`extension/src/pipeline/`，在私有仓库 VideoScoreRecon-ext 维护），
本分支主要维护 Python 参考实现。

## 开发与测试

```bash
uv sync && uv run pytest    # 62 例：时间解析/去重/B站API/YTDLP/ScoreDetect/拼接/JobStore
```

- `tests/` 为 pytest 测试（`src/videocore/*` 与 `src/video_scrap/bili/*` 使用兄弟导入，
  由 `pipeline.py` 注入 `sys.path`；单独调试请在其目录内运行）
- `test/` 手工工具：`comp_similar_pics.py`（图片相似度对比，复用 `videocore/dedup.py` 核心）
- `src/videocore/test_pic_exp.py` 纯图像裁剪实验（`data/pic_exp/` → `data/pic_exp_out/`），
  不依赖视频流水线

## 目录结构

```
src/                  Python 主项目
  main.py             CLI 入口
  pipeline.py         共享编排（CLI 与服务共用，URL 分流 + 进度回调）
  videocore/          核心算法：video_io 抽帧 / score_detect 检测 / pic_clip 裁剪 / dedup 去重 / 拼接
  video_scrap/        下载器：bili（B站 DASH）/ ytdlp（YouTube）
  server/             FastAPI 本地服务（app.py + jobs.py）
tests/                pytest 测试
test/                 手工工具（dedup 对比等）
extension/            Chrome 扩展 0.1.0（B 站页薄客户端）
data/                 运行数据（gitignore）
```

## 已知限制

- 仅支持白纸乐谱视频（阈值化检测，深色模式不支持）；参数按典型乐谱 App 调优
- 拼接输出为单张 PNG（`final/res.png`），无超高分段
- B 站 playurl 接口可能变动（WBI 签名未实现）；游客画质有限
- YouTube 下载依赖 yt-dlp 与网络可达性，会员专享内容不可下载
- 扩展为 0.1.0 薄客户端，需本地服务在线；完整功能见私有仓库 VideoScoreRecon-ext