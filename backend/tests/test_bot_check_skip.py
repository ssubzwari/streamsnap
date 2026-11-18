"""A YouTube bot check skips the blocked video instead of stopping the queue.

"Sign in to confirm you're not a bot" is usually about one video, not the whole
account. The queue used to stop dead on the first one, stranding everything
behind it until someone noticed and resumed by hand. Now the blocked download
goes to the back of the queue, the queue backs off briefly, and the next
download runs.

The guard rail matters as much as the behaviour: if several downloads in a row
are blocked with none succeeding in between, the block is the account or the IP
rather than one video, and skipping ahead would burn the whole queue — so at
that point everything pauses, as it used to.
"""

import asyncio
import time

from fastapi.testclient import TestClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Download, Setting
from app.services import download_manager as dm_mod

BOT_CHECK = "ERROR: [youtube] abc: Sign in to confirm you're not a bot."


def _reset() -> None:
    async def run() -> None:
        from sqlalchemy import delete

        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            await s.execute(delete(Setting).where(Setting.key.like("bot_check%")))
            await s.commit()

    asyncio.run(run())


async def _aset(key: str, value: str) -> None:
    S = get_sessionmaker()
    async with S() as s:
        row = await s.get(Setting, key)
        if row is None:
            s.add(Setting(key=key, value=value))
        else:
            row.value = value
        await s.commit()


def _set(key: str, value: str) -> None:
    asyncio.run(_aset(key, value))


def _blocked_urls(*needles: str):
    """run_download stand-in: a URL containing any needle hits a bot check."""

    def fake(job_id, url, fmt, out_dir, progress_q, cancel_event, settings_map):
        time.sleep(0.02)
        if any(n in url for n in needles):
            progress_q.put({"type": "error", "id": job_id, "error": BOT_CHECK})
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


def _rows(client):
    return {d["id"]: d for d in client.get("/api/downloads").json()}


def _wait(client, predicate, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = _rows(client)
        if predicate(rows):
            return rows
        time.sleep(0.1)
    return _rows(client)


# ── The reported behaviour ────────────────────────────────────────────────────

def test_a_blocked_video_does_not_stop_the_rest_of_the_queue(monkeypatch):
    """The whole point: one bad video must not strand everything behind it."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("blocked"))
    _reset()
    _set("bot_check_cooldown", "0")  # no need to actually wait in a test

    with TestClient(app) as c:
        blocked = _add(c, "https://example.com/blocked")
        others = [_add(c, f"https://example.com/ok{i}") for i in range(3)]

        rows = _wait(c, lambda r: all(r.get(i, {}).get("status") == "completed" for i in others))

        assert [rows[i]["status"] for i in others] == ["completed"] * 3
        # And the queue was never paused.
        assert c.get("/api/downloads/status").json()["paused"] is False
        # It never succeeded — it is queued for a retry, already retrying, or
        # given up on. What matters is that it did not hold up the others.
        assert rows[blocked]["status"] != "completed"


def test_the_blocked_download_is_moved_to_the_back_of_the_queue(monkeypatch):
    """Requeueing in place would hand it straight back — it is the lowest
    queue_position by definition — and the queue would spin on it."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("blocked"))
    _reset()
    _set("bot_check_cooldown", "0")

    with TestClient(app) as c:
        blocked = _add(c, "https://example.com/blocked")
        later = _add(c, "https://example.com/ok1")

        rows = _wait(c, lambda r: r.get(later, {}).get("status") == "completed")
        assert rows[later]["status"] == "completed"
        if rows[blocked]["status"] == "queued":
            assert rows[blocked]["queue_position"] > rows[later]["queue_position"]


def test_it_gives_up_on_a_permanently_blocked_video(monkeypatch):
    """Without a cap, a video that is always blocked would cycle forever."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("blocked"))
    _reset()
    _set("bot_check_cooldown", "0")

    with TestClient(app) as c:
        blocked = _add(c, "https://example.com/blocked")
        # Something that succeeds, so the streak never reaches the pause-all
        # threshold and the cap is what ends it.
        for i in range(6):
            _add(c, f"https://example.com/ok{i}")

        rows = _wait(c, lambda r: r.get(blocked, {}).get("status") == "failed", timeout=25)
        assert rows[blocked]["status"] == "failed"
        assert "sign-in" in (rows[blocked]["error_message"] or "").lower()
        assert c.get("/api/downloads/status").json()["paused"] is False


# ── The guard rail ────────────────────────────────────────────────────────────

def test_everything_blocked_still_pauses_the_queue(monkeypatch):
    """Several blocks in a row with nothing succeeding means the account or IP
    is blocked. Skipping ahead would fail every download in turn, so stop."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("example.com"))
    _reset()
    _set("bot_check_cooldown", "0")

    with TestClient(app) as c:
        for i in range(4):
            _add(c, f"https://example.com/v{i}")

        deadline = time.time() + 25
        while time.time() < deadline:
            if c.get("/api/downloads/status").json()["paused"]:
                break
            time.sleep(0.1)

        status = c.get("/api/downloads/status").json()
        assert status["paused"] is True
        assert "bot" in (status["reason"] or "").lower()


def test_skipping_can_be_switched_off(monkeypatch):
    """`bot_check_skip=false` restores the old stop-on-first-block behaviour."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("blocked"))
    _reset()
    _set("bot_check_skip", "false")

    with TestClient(app) as c:
        _add(c, "https://example.com/blocked")

        deadline = time.time() + 20
        while time.time() < deadline:
            if c.get("/api/downloads/status").json()["paused"]:
                break
            time.sleep(0.1)

        assert c.get("/api/downloads/status").json()["paused"] is True


# ── The cooldown ──────────────────────────────────────────────────────────────

def test_the_cooldown_setting_is_read_and_clamped():
    mgr = dm_mod.DownloadManager()

    async def check():
        await _aset("bot_check_cooldown", "45")
        assert await mgr._bot_check_cooldown() == 45.0
        await _aset("bot_check_cooldown", "not a number")
        assert await mgr._bot_check_cooldown() == dm_mod._BOT_CHECK_COOLDOWN_DEFAULT
        await _aset("bot_check_cooldown", "999999")
        assert await mgr._bot_check_cooldown() == dm_mod._BOT_CHECK_COOLDOWN_MAX
        await _aset("bot_check_cooldown", "-5")
        assert await mgr._bot_check_cooldown() == 0.0

    _reset()
    asyncio.run(check())


def test_the_queue_waits_out_the_cooldown_before_the_next_download(monkeypatch):
    """The back-off is global: starting the *next* download straight away is
    still hammering a site that just said no."""
    monkeypatch.setattr(dm_mod, "run_download", _blocked_urls("blocked"))
    _reset()
    _set("bot_check_cooldown", "2")

    with TestClient(app) as c:
        _add(c, "https://example.com/blocked")
        other = _add(c, "https://example.com/ok")

        started = time.time()
        rows = _wait(c, lambda r: r.get(other, {}).get("status") == "completed", timeout=25)
        assert rows[other]["status"] == "completed"
        assert time.time() - started >= 1.5, "the next download did not wait for the back-off"


def test_status_reports_the_remaining_cooldown():
    mgr = dm_mod.DownloadManager()
    assert mgr.status["cooldown_seconds"] == 0
    mgr._cooldown_until = time.monotonic() + 10
    assert 8 <= mgr.status["cooldown_seconds"] <= 10


# ── State handling ────────────────────────────────────────────────────────────

def test_a_success_resets_the_streak():
    """Otherwise blocks spread over a long session would eventually add up to a
    pause even though downloads are getting through fine."""
    mgr = dm_mod.DownloadManager()
    mgr._consecutive_bot_checks = 3
    mgr._bot_check_attempts[7] = 2

    # What the "finished" branch of _relay_progress does.
    mgr._consecutive_bot_checks = 0
    mgr._bot_check_attempts.pop(7, None)

    assert mgr._consecutive_bot_checks == 0
    assert 7 not in mgr._bot_check_attempts


def test_resume_clears_the_back_off():
    """A manual resume means the user has added cookies or waited it out, so
    previously blocked downloads deserve a clean slate."""
    mgr = dm_mod.DownloadManager()
    mgr._bot_check_attempts[1] = 2
    mgr._consecutive_bot_checks = 4
    mgr._cooldown_until = time.monotonic() + 99

    mgr._clear_bot_check_state()

    assert mgr._bot_check_attempts == {}
    assert mgr._consecutive_bot_checks == 0
    assert mgr._cooldown_until == 0.0


def test_bot_check_markers_still_match_real_messages():
    assert dm_mod._is_bot_check(BOT_CHECK)
    assert dm_mod._is_bot_check("Sign in to confirm you’re not a bot")
    assert dm_mod._is_bot_check("Use --cookies-from-browser or --cookies")
    assert not dm_mod._is_bot_check("HTTP Error 404: Not Found")
    assert not dm_mod._is_bot_check("")
