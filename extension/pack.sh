#!/usr/bin/env bash
# 打包 Chrome Web Store 上传 zip（排除测试与开发文件）
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/videoscore-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js content.js options.html options.js panel.css ui.css \
  worker_host.html worker_host.js \
  editor.html editor.js editor.css \
  icons \
  src/b64.js src/acquire.js src/worker.js src/decode.js src/stitch.js \
  src/pipeline \
  lib \
  -x '*.DS_Store' -x '*__pycache__*'

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "包含: $(unzip -l "$OUT" | tail -1)"
