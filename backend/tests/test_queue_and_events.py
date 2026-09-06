import asyncio

from fastapi.testclient import TestClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Download
from app.services.external_notifier import _channel_wants


def _seed(n: int) -> None:
    async def run() -> None:
        from sqlalchemy import delete
        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            for i in range(n):
                s.add(Download(url=f"u{i}", title=f"t{i}", status="queued",
                               queue_position=i + 1, format_spec="best"))
            await s.commit()
    asyncio.run(run())


def test_queue_reorder_moves_last_to_first():
    with TestClient(app) as c:
        _seed(3)
        ids = [d["id"] for d in sorted(c.get("/api/downloads").json(),
                                       key=lambda d: d["queue_position"])]
        r = c.post("/api/downloads/queue/reorder",
                   json={"ordered_ids": [ids[2], ids[0], ids[1]]})
        assert r.status_code == 200
        got = {d["id"]: d["queue_position"] for d in r.json()}
        assert got[ids[2]] == 1
        assert got[ids[0]] == 2
        assert got[ids[1]] == 3


def test_queue_reorder_partial_keeps_others_after():
    with TestClient(app) as c:
        _seed(4)
        ids = [d["id"] for d in sorted(c.get("/api/downloads").json(),
                                       key=lambda d: d["queue_position"])]
        r = c.post("/api/downloads/queue/reorder", json={"ordered_ids": [ids[3]]})
        rows = {d["id"]: d["queue_position"] for d in r.json()}
        assert rows[ids[3]] == 1
        # unlisted keep their prior relative order, now shifted down by one
        assert rows[ids[0]] == 2 and rows[ids[1]] == 3 and rows[ids[2]] == 4


def test_channel_event_filter_defaults():
    assert _channel_wants("completed", None) is True
    assert _channel_wants("summary", None) is True
    assert _channel_wants("download_started", None) is False
    # explicit list wins
    assert _channel_wants("completed", ["summary"]) is False
    assert _channel_wants("summary", ["summary"]) is True
    # operational alerts always pass
    assert _channel_wants("auth_required", []) is True
