"""pytest 共享配置：把各兄弟导入目录加入 sys.path（与 src/main.py、pipeline.py 一致）"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

for _p in (
    REPO / "src",
    REPO / "src" / "server",
    REPO / "src" / "videocore",
    REPO / "src" / "video_scrap" / "bili",
):
    s = str(_p)
    if s not in sys.path:
        sys.path.insert(0, s)
