"""
内存任务队列 + 单 worker 串行处理

任务状态机：queued -> running -> done / error
"""

import threading
import time
import uuid
from collections import deque


class JobStore:
    def __init__(self, data_dir, max_size=100, start_worker=True):
        self.data_dir = data_dir
        self._max_size = max_size
        self._jobs = {}
        self._queue = deque()
        self._lock = threading.Lock()
        if start_worker:
            threading.Thread(target=self._run, daemon=True).start()

    def create(self, params):
        """入队一个新任务，返回 job_id"""
        with self._lock:
            if len(self._jobs) >= self._max_size:
                # 按创建时间从旧到新，丢弃已完成的旧任务直到容量下降
                done_jobs = sorted(
                    (j for j in self._jobs.values() if j.get("done")),
                    key=lambda j: j["created"],
                )
                overflow = len(self._jobs) - self._max_size + 1
                for j in done_jobs[:overflow]:
                    del self._jobs[j["id"]]
            job_id = uuid.uuid4().hex[:12]
            self._jobs[job_id] = {
                "id": job_id,
                "params": params,
                "stage": "queued",
                "progress": 0.0,
                "message": "排队中",
                "done": False,
                "error": None,
                "result": None,
                "created": time.time(),
            }
            self._queue.append(job_id)
        return job_id

    def get(self, job_id):
        """
        返回任务状态快照（dict 或 None）

        params 中的 cookie（SESSDATA）不回传，避免凭 token 读回用户凭据。
        """
        with self._lock:
            j = self._jobs.get(job_id)
            if j is None:
                return None
            snap = dict(j)
            if isinstance(snap.get("params"), dict):
                snap["params"] = {
                    k: v for k, v in snap["params"].items() if k != "cookie"
                }
            return snap

    def _params_copy(self, job_id):
        """在锁内拷贝任务参数（供 worker 使用，避免竞态）"""
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j["params"]) if j and isinstance(j.get("params"), dict) else {}

    def _update(self, job_id, **kw):
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(kw)

    def _run(self):
        while True:
            with self._lock:
                job_id = self._queue.popleft() if self._queue else None
            if job_id is None:
                time.sleep(0.2)
                continue
            self._process(job_id)

    def _process(self, job_id):
        params = self._params_copy(job_id)
        self._update(job_id, stage="running", message="处理中")

        def on_progress(stage, progress, message=""):
            self._update(job_id, stage=stage, progress=progress, message=message)

        try:
            from pipeline import run_pipeline
            result = run_pipeline(
                video_input=params["url"],
                data_dir=str(self.data_dir),
                interval_sec=params.get("interval_sec", 2),
                dedup_threshold=params.get("dedup_threshold", 0.01),
                stitch=True,
                start_time=params.get("start_time"),
                end_time=params.get("end_time"),
                cookie=params.get("cookie"),
                on_progress=on_progress,
            )
            self._update(job_id, stage="done", progress=1.0,
                         done=True, result=result, message="完成")
        except Exception as e:  # noqa: BLE001
            self._update(job_id, stage="error", done=True,
                         error=str(e), message=f"失败: {e}")
