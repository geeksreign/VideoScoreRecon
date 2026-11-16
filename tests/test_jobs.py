"""JobStore：按序淘汰、cookie 不回传、锁内参数拷贝（不启动 worker 线程）"""

from jobs import JobStore


def _make_store(max_size=100):
    return JobStore(data_dir=".", max_size=max_size, start_worker=False)


def _seed(store, jid, done=False, created=0.0):
    store._jobs[jid] = {
        "id": jid,
        "params": {"url": "u"},
        "stage": "done" if done else "queued",
        "progress": 1.0 if done else 0.0,
        "message": "",
        "done": done,
        "error": None,
        "result": None,
        "created": created,
    }


def test_create_and_get():
    s = _make_store()
    jid = s.create({"url": "http://x"})
    snap = s.get(jid)
    assert snap is not None
    assert snap["id"] == jid
    assert snap["stage"] == "queued"
    assert s.get("nonexistent") is None


def test_get_strips_cookie():
    """回归：progress 快照不得回传 SESSDATA"""
    s = _make_store()
    jid = s.create({"url": "u", "cookie": "TOPSECRET", "interval_sec": 2})
    snap = s.get(jid)
    assert "cookie" not in snap["params"]
    assert "TOPSECRET" not in str(snap)
    # 原始任务数据保留（worker 仍可用）
    assert s._jobs[jid]["params"]["cookie"] == "TOPSECRET"


def test_eviction_drops_oldest_done_first():
    """回归：满员时按 created 升序淘汰最旧的已完成任务"""
    s = _make_store(max_size=4)
    _seed(s, "a", done=False, created=10)
    _seed(s, "b", done=True, created=20)
    _seed(s, "c", done=False, created=30)
    _seed(s, "d", done=True, created=40)
    s.create({"url": "new"})
    assert "b" not in s._jobs       # 最旧已完成被淘汰
    assert "d" in s._jobs           # 较新已完成保留
    assert "a" in s._jobs and "c" in s._jobs


def test_eviction_never_touches_active_jobs():
    s = _make_store(max_size=3)
    _seed(s, "a", done=False, created=10)
    _seed(s, "b", done=False, created=20)
    _seed(s, "c", done=False, created=30)
    s.create({"url": "new"})        # 无可删的已完成任务 → 仍可创建（温和淘汰）
    assert {"a", "b", "c"} <= set(s._jobs)
    assert len(s._jobs) == 4


def test_params_copy_is_a_copy():
    s = _make_store()
    jid = s.create({"url": "u", "cookie": "secret"})
    p = s._params_copy(jid)
    p["cookie"] = "mutated"
    assert s._jobs[jid]["params"]["cookie"] == "secret"
