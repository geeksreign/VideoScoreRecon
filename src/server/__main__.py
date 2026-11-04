"""
启动本地服务

用法:
    cd src && python -m server
"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(SRC / "server"))

import uvicorn  # noqa: E402

from app import TOKEN, app  # noqa: E402

if __name__ == "__main__":
    print("=" * 56, flush=True)
    print("  本地曲谱提取服务已启动 (http://127.0.0.1:8000)", flush=True)
    print(f"  服务 Token: {TOKEN}", flush=True)
    print("  请在扩展设置页填写该 Token", flush=True)
    print("=" * 56, flush=True)
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
