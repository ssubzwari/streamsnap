"""Videos the site no longer has are removed, not left as permanent failures.

"Video unavailable — the YouTube account associated with this video has been
terminated" is not a download that went wrong. The video is gone, no retry can
bring it back, and in a long playlist these pile up as red rows that have to be
cleared one at a time.

They are deleted instead, and what was dropped is reported **once**, when the
queue drains — the end of the playlist — rather than one alert per video.
"""

import asyncio
import time

from fastapi.testclient import TestClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Download, Notification, Setting
from app.services import download_manager as dm_mod

TERMINATED = (
    "ERROR: [youtube] sJcczPk7DjM: Video unavailable. This video is no longer "
    "available because the YouTube account associated with this video has been "
    "terminated."
)
PRIVATE = "ERROR: [youtube] abc: Private video. Sign in if you've been granted access."
REMOVED = "ERROR: [youtube] xyz: This video has been removed by the uploader."


def _reset() -> None:
    async def run() -> None:
        from sqlalchemy import delete

        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            await s.execute(delete(Notification))
            await s.execute(delete(Setting).where(Setting.key == "auto_remove_unavailable"))
            await s.commit()

    asyncio.run(run())


def _set(key: str, value: str) -> None:
    async def run() -> None:
        S = get_sessionmaker()
        async with S() as s:
            row = await s.get(Setting, key)
            if row is None:
                s.add(Setting(key=key, value=value))
            else:
                row.value = value
            await s.commit()

    asyncio.run(run())


def _runner(failures: dict[str, str]):
    """run_download stand-in: URLs containing a key fail with its message."""

    def fake(job_id, url, fmt, out_dir, progress_q, cancel_event, settings_map):
        time.sleep(0.02)
        for needle, message in failures.items():
            if needle in url:
                progress_q.put({"type": "error", "id": job_id, "error": message})
                return None
        path = f"{out_dir}/{job_id}.mp4"
        progress_q.put({
            "type": "finished", "id": job_id, "output_path": path, "ext": "mp4",
            "height": 1080, "filesize": 1, "vcodec": "avc1", "acodec": "mp4a",
        })
        return path

    return fake


def _add(client, url):
    r = client.post("/api/downloads", json={"url": url, "format_spec": "best"})
    assert r.status_code == 201
    return r.json()["id"]


def _wait(client, predicate, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = client.get("/api/downloads").json()
        if predicate(rows):
            return rows
        time.sleep(0.1)
    return client.get("/api/downloads").json()


def _notifications(client):
    return client.get("/api/notifications").json()


# ── Removal ───────────────────────────────────────────────────────────────────

def test_a_terminated_channels_video_is_removed(monkeypatch):
    monkeypatch.setattr(dm_mod, "run_download", _runner({"gone": TERMINATED}))
    _reset()

    with TestClient(app) as c:
        gone = _add(c, "https://youtube.com/watch?v=gone")
        rows = _wait(c, lambda r: all(d["id"] != gone for d in r))

    assert all(d["id"] != gone for d in rows), "the row should be gone, not failed"


def test_private_and_uploader_removed_videos_go_too(monkeypatch):
    monkeypatch.setattr(
        dm_mod, "run_download", _runner({"priv": PRIVATE, "del": REMOVED})
    )
    _reset()

    with TestClient(app) as c:
        a = _add(c, "https://youtube.com/watch?v=priv")
        b = _add(c, "https://youtube.com/watch?v=del")
        rows = _wait(c, lambda r: all(d["id"] not in (a, b) for d in r))

    assert all(d["id"] not in (a, b) for d in rows)


def test_a_real_failure_is_still_kept(monkeypatch):
    """Only "the video is gone" is removed. A network error is a genuine
    failure the user may want to retry, so it stays."""
    monkeypatch.setattr(
        dm_mod, "run_download", _runner({"boom": "ERROR: unable to download video data: HTTP Error 500"})
    )
    _reset()

    with TestClient(app) as c:
        did = _add(c, "https://youtube.com/watch?v=boom")
        rows = _wait(c, lambda r: any(d["id"] == did and d["status"] == "failed" for d in r))

    row = next(d for d in rows if d["id"] == did)
    assert row["status"] == "failed"
    assert "500" in (row["error_message"] or "")


def test_removal_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(dm_mod, "run_download", _runner({"gone": TERMINATED}))
    _reset()
    _set("auto_remove_unavailable", "false")

    with TestClient(app) as c:
        did = _add(c, "https://youtube.com/watch?v=gone")
        rows = _wait(c, lambda r: any(d["id"] == did and d["status"] == "failed" for d in r))

    assert next(d for d in rows if d["id"] == did)["status"] == "failed"


def test_the_rest_of_the_playlist_still_downloads(monkeypatch):
    monkeypatch.setattr(dm_mod, "run_download", _runner({"gone": TERMINATED}))
    _reset()

    with TestClient(app) as c:
        _add(c, "https://youtube.com/watch?v=gone1")
        good = [_add(c, f"https://youtube.com/watch?v=ok{i}") for i in range(3)]
        _add(c, "https://youtube.com/watch?v=gone2")

        rows = _wait(c, lambda r: len(r) == 3 and all(
            any(d["id"] == i and d["status"] == "completed" for d in r) for i in good
        ))

    assert len([d for d in rows if d["status"] == "completed"]) == 3
    assert len(rows) == 3, "both unavailable rows should be gone"


# ── The summary ───────────────────────────────────────────────────────────────

def test_one_summary_for_a_whole_playlist_not_one_per_video(monkeypatch):
    """The point of collecting them: a dozen dead videos is one notification."""
    monkeypatch.setattr(dm_mod, "run_download", _runner({"gone": TERMINATED}))
    _reset()

    with TestClient(app) as c:
        for i in range(4):
            _add(c, f"https://youtube.com/watch?v=gone{i}")
        _add(c, "https://youtube.com/watch?v=ok")

        deadline = time.time() + 20
        summaries = []
        while time.time() < deadline:
            summaries = [n for n in _notifications(c) if "unavailable" in n["title"].lower()]
            if summaries:
                break
            time.sleep(0.2)

    assert len(summaries) == 1, f"expected one summary, got {len(summaries)}"
    assert "4" in summaries[0]["title"]


def test_the_summary_says_why_each_one_went(monkeypatch):
    monkeypatch.setattr(
        dm_mod, "run_download",
        _runner({"term": TERMINATED, "priv": PRIVATE, "del": REMOVED}),
    )
    _reset()

    with TestClient(app) as c:
        for n in ("term", "priv", "del"):
            _add(c, f"https://youtube.com/watch?v={n}")

        deadline = time.time() + 20
        body = ""
        while time.time() < deadline:
            found = [n for n in _notifications(c) if "unavailable" in n["title"].lower()]
            if found:
                body = found[0]["body"] or ""
                break
            time.sleep(0.2)

    assert "channel terminated" in body
    assert "made private" in body
    assert "removed by the uploader" in body


def test_a_single_video_is_reported_on_its_own(monkeypatch):
    """One video, singular wording — not "these 1 videos"."""
    monkeypatch.setattr(dm_mod, "run_download", _runner({"gone": TERMINATED}))
    _reset()

    with TestClient(app) as c:
        _add(c, "https://youtube.com/watch?v=gone")
        deadline = time.time() + 20
        found = []
        while time.time() < deadline:
            found = [n for n in _notifications(c) if "unavailable" in n["title"].lower()]
            if found:
                break
            time.sleep(0.2)

    assert found, "a single removal should still be reported"
    assert "1 unavailable video" in found[0]["title"]
    assert "This video was" in (found[0]["body"] or "")


# ── Marker matching ───────────────────────────────────────────────────────────

def test_markers_match_the_real_messages():
    assert dm_mod._is_unavailable(TERMINATED)
    assert dm_mod._is_unavailable(PRIVATE)
    assert dm_mod._is_unavailable(REMOVED)
    assert dm_mod._is_unavailable("ERROR: [youtube] x: This video is private.")
    # Not these.
    assert not dm_mod._is_unavailable("HTTP Error 500: Internal Server Error")
    assert not dm_mod._is_unavailable("Sign in to confirm you're not a bot")
    assert not dm_mod._is_unavailable("")


def test_reasons_are_specific():
    r = dm_mod.DownloadManager._unavailable_reason
    assert r(TERMINATED) == "channel terminated"
    assert r(PRIVATE) == "made private"
    assert r(REMOVED) == "removed by the uploader"
    assert r("Video unavailable") == "no longer available"


def test_a_bot_check_is_not_mistaken_for_a_dead_video():
    """These two paths must not overlap — one defers, the other deletes."""
    bot = "ERROR: [youtube] x: Sign in to confirm you're not a bot."
    assert dm_mod._is_bot_check(bot)
    assert not dm_mod._is_unavailable(bot)
    assert not dm_mod._is_bot_check(TERMINATED)
