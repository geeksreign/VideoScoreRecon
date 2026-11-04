"""
FastAPI 本地服务

仅监听 127.0.0.1，供浏览器扩展调用。除 /api/health 外均需 X-Auth-Token。
"""

import os
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from jobs import JobStore

TOKEN = os.environ.get("SCORE_SERVER_TOKEN") or secrets.token_hex(16)

REPO = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("SCORE_DATA_DIR", REPO / "data"))

app = FastAPI(title="ScoreRecon Local Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # 本地服务，仅扩展访问
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = JobStore(DATA_DIR)


class ExtractRequest(BaseModel):
    url: str
    start_time: float | None = None
    end_time: float | None = None
    interval_sec: float = 2
    dedup_threshold: float = 0.01
    cookie: str | None = None


def _require_token(x_auth_token: str | None = Header(default=None)):
    if x_auth_token != TOKEN:
        raise HTTPException(status_code=401, detail="无效或缺失 token")


@app.get("/api/health")
def health():
    return {"ok": True, "data_dir": str(DATA_DIR)}


@app.post("/api/extract", dependencies=[Depends(_require_token)])
def submit(req: ExtractRequest):
    job_id = store.create(req.model_dump())
    return {"job_id": job_id}


@app.get("/api/progress/{job_id}", dependencies=[Depends(_require_token)])
def progress(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    return job


@app.get("/api/result/{job_id}", dependencies=[Depends(_require_token)])
def result(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    if not job.get("done") or not job.get("result"):
        raise HTTPException(status_code=409, detail="任务尚未完成")
    path = job["result"].get("result_path")
    if not path or not Path(path).exists():
        raise HTTPException(status_code=404, detail="结果文件不存在")
    media_type = "image/png" if path.endswith(".png") else "image/jpeg"
    return FileResponse(path, media_type=media_type)
