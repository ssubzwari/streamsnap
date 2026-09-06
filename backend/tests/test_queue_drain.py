import asyncio
import time

from fastapi.testclient import TestClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Download
from app.services import download_manager as dm_mod


def _reset_downloads() -> None:
    async def run() -> None:
        from sqlalchemy import delete

        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            await s.commit()

    asyncio.run(run())


def _instant_finish(job_id, url, fmt, out_dir, progress_q, cancel_event, settings_map):
    """Stand-in for run_download: report the job finished almost immediately."""
    time.sleep(0.02)
    path = f"{out_dir}/{job_id}.mp4"
    progress_q.put(
        {
            "type": "finished",
            "id": job_id,
            "output_path": path,
            "ext": "mp4",
            "height": 1080,
            "filesize": 1,
            "vcodec": "avc1",
            "acodec": "mp4a",
        }
    )
    return path


def _add(client, url):
    r = client.post("/api/downloads", json={"url": url, "format_spec": "best"})
    assert r.status_code == 201
    return r.json()["id"]


def _wait_all_completed(client, ids, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = {d["id"]: d["status"] for d in client.get("/api/downloads").json()}
        if all(rows.get(i) == "completed" for i in ids):
            return rows
        time.sleep(0.1)
    return {d["id"]: d["status"] for d in client.get("/api/downloads").json()}


def test_queue_keeps_draining(monkeypatch):
    """Regression: reordering the pending queue used to strand the rest of it.

    The worker consumed one wake-token per download; a pass that found nothing
    runnable (which a reorder can momentarily cause) burned a token for good,
    so once the reordered item finished the remaining queued rows never
    started. Both scenarios below now finish the whole queue.
    """
    monkeypatch.setattr(dm_mod, "run_download", _instant_finish)
    _reset_downloads()

    with TestClient(app) as c:
        # 1) a plain queue drains completely
        batch1 = [_add(c, f"https://example.com/a{i}") for i in range(5)]
        rows = _wait_all_completed(c, batch1)
        assert all(rows.get(i) == "completed" for i in batch1), rows

        # 2) a queue that gets reordered mid-flight still drains completely
        batch2 = [_add(c, f"https://example.com/b{i}") for i in range(4)]
        c.post(
            "/api/downloads/queue/reorder",
            json={"ordered_ids": [batch2[3], batch2[0], batch2[1], batch2[2]]},
        )
        rows = _wait_all_completed(c, batch2)
        assert all(rows.get(i) == "completed" for i in batch2), rows
