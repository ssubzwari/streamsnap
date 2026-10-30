"""Folder destinations, file manager moves and library updates.

Each test runs against a temporary DOWNLOAD_DIR with download execution
stubbed out, so nothing touches the network or the real download folder.
"""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import engine, get_sessionmaker
from app.main import app
from app.models import Download, Setting, Subscription
from app.services.download_manager import download_manager


@pytest.fixture
def root(tmp_path, monkeypatch):
    folder = tmp_path / "downloads"
    folder.mkdir()
    monkeypatch.setattr(settings, "DOWNLOAD_DIR", str(folder))

    async def no_enqueue(*args, **kwargs):
        return None

    monkeypatch.setattr(download_manager, "enqueue", no_enqueue)
    return folder


@pytest.fixture
def client(root):
    with TestClient(app) as c:
        yield c


def _db(fn):
    """Run ``fn(session)`` in a fresh loop, then drop the pooled connection."""
    async def run():
        async with get_sessionmaker()() as session:
            return await fn(session)

    try:
        return asyncio.run(run())
    finally:
        asyncio.run(engine.dispose())


def _touch(path, text="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    return path


def _seed_download(**fields):
    async def fn(session):
        row = Download(url="https://example.test/v", format_spec="best", **fields)
        session.add(row)
        await session.commit()
        return row.id

    return _db(fn)


def _download(download_id):
    async def fn(session):
        row = await session.get(Download, download_id)
        return {"output_path": row.output_path, "output_dir": row.output_dir} if row else None

    return _db(fn)


# ── path boundary ────────────────────────────────────────────────────────────

def test_listing_refuses_paths_outside_root(client):
    assert client.get("/api/files", params={"path": "../"}).status_code == 400
    # A leading slash is root-relative, so "/etc" means "<root>/etc" — not found, never /etc.
    assert client.get("/api/files", params={"path": "/etc"}).status_code == 404


def test_symlink_pointing_outside_root_is_refused(client, root, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, root / "escape")
    assert client.get("/api/files", params={"path": "escape"}).status_code == 400


def test_folder_create_rejects_bad_names(client):
    for bad in ("..", "a/b", ""):
        assert client.post("/api/files/folders", json={"path": "", "name": bad}).status_code == 400


# ── file manager: move / copy / rename / delete ──────────────────────────────

def test_move_file_repoints_library_row(client, root):
    src = _touch(str(root / "Show" / "ep1.mp4"))
    download_id = _seed_download(title="ep1", status="completed",
                                 output_path=src, output_dir=str(root / "Show"))
    _touch(str(root / "Shows" / ".keep"))

    r = client.post("/api/files/transfer", json={"items": ["Show/ep1.mp4"], "dest": "Shows", "mode": "move"})
    assert r.status_code == 200
    assert r.json()["results"][0]["ok"], r.json()

    assert not os.path.exists(src)
    moved = str(root / "Shows" / "ep1.mp4")
    assert os.path.exists(moved)
    assert _download(download_id)["output_path"] == moved


def test_move_folder_repoints_downloads_and_subscription(client, root):
    folder = str(root / "Music" / "Album")
    f1 = _touch(os.path.join(folder, "a.m4a"))
    _touch(str(root / "Dest" / ".keep"))

    async def seed(session):
        sub = Subscription(url="https://example.test/pl", title="Album", download_dir=folder)
        session.add(sub)
        await session.flush()
        dl = Download(url="u", format_spec="best", status="completed", output_path=f1,
                      output_dir=folder, subscription_id=sub.id)
        session.add(dl)
        await session.commit()
        return sub.id, dl.id

    sub_id, dl_id = _db(seed)

    r = client.post("/api/files/transfer", json={"items": ["Music/Album"], "dest": "Dest", "mode": "move"})
    assert r.json()["results"][0]["ok"], r.json()

    new_folder = str(root / "Dest" / "Album")
    assert os.path.exists(os.path.join(new_folder, "a.m4a"))
    assert _download(dl_id) == {
        "output_path": os.path.join(new_folder, "a.m4a"),
        "output_dir": new_folder,
    }

    async def read_sub(session):
        return (await session.get(Subscription, sub_id)).download_dir

    assert _db(read_sub) == new_folder


def test_copy_leaves_library_untouched(client, root):
    src = _touch(str(root / "Show" / "ep1.mp4"))
    download_id = _seed_download(title="ep1", status="completed", output_path=src, output_dir=str(root / "Show"))
    _touch(str(root / "Copies" / ".keep"))

    r = client.post("/api/files/transfer", json={"items": ["Show/ep1.mp4"], "dest": "Copies", "mode": "copy"})
    assert r.json()["results"][0]["ok"], r.json()

    assert os.path.exists(src) and os.path.exists(root / "Copies" / "ep1.mp4")
    assert _download(download_id)["output_path"] == src


def test_move_refuses_name_clash_without_overwriting(client, root):
    _touch(str(root / "A" / "x.mp4"), "source")
    _touch(str(root / "B" / "x.mp4"), "existing")

    r = client.post("/api/files/transfer", json={"items": ["A/x.mp4"], "dest": "B", "mode": "move"})
    result = r.json()["results"][0]
    assert result["ok"] is False and "exists" in result["error"]
    assert (root / "B" / "x.mp4").read_text() == "existing"
    assert (root / "A" / "x.mp4").exists()


def test_move_folder_into_itself_is_refused(client, root):
    _touch(str(root / "A" / "B" / "f.txt"))
    r = client.post("/api/files/transfer", json={"items": ["A"], "dest": "A/B", "mode": "move"})
    assert r.json()["results"][0]["ok"] is False
    assert (root / "A" / "B" / "f.txt").exists()


def test_move_blocked_while_download_is_running_in_folder(client, root):
    folder = str(root / "Busy")
    src = _touch(os.path.join(folder, "live.part"))
    _seed_download(title="live", status="downloading", output_dir=folder, output_path=None)
    _touch(str(root / "Dest" / ".keep"))

    r = client.post("/api/files/transfer", json={"items": ["Busy"], "dest": "Dest", "mode": "move"})
    assert r.json()["results"][0]["ok"] is False
    assert os.path.exists(src)


def test_rename_updates_library_path(client, root):
    src = _touch(str(root / "Show" / "old.mp4"))
    download_id = _seed_download(title="old", status="completed", output_path=src, output_dir=str(root / "Show"))

    r = client.post("/api/files/rename", json={"path": "Show/old.mp4", "name": "new.mp4"})
    assert r.status_code == 200
    assert _download(download_id)["output_path"] == str(root / "Show" / "new.mp4")


def test_delete_removes_file_and_its_library_row(client, root):
    src = _touch(str(root / "Gone" / "ep.mp4"))
    download_id = _seed_download(title="ep", status="completed", output_path=src, output_dir=str(root / "Gone"))

    r = client.post("/api/files/delete", json={"items": ["Gone/ep.mp4"]})
    assert r.json()["results"][0]["ok"], r.json()
    assert not os.path.exists(src)
    assert _download(download_id) is None


# ── subscription folder change ───────────────────────────────────────────────

def test_subscription_folder_change_moves_files_and_library(client, root):
    folder = str(root / "Music" / "Playlist A")
    f1 = _touch(os.path.join(folder, "one.m4a"))
    _touch(str(root / "Pakistani Drama" / ".keep"))

    async def seed(session):
        sub = Subscription(url="https://example.test/plA", title="Playlist A", download_dir=folder)
        session.add(sub)
        await session.flush()
        session.add(Download(url="u", format_spec="best", status="completed", output_path=f1,
                             output_dir=folder, subscription_id=sub.id))
        await session.commit()
        return sub.id

    sub_id = _db(seed)

    r = client.patch(f"/api/subscriptions/{sub_id}", json={"download_folder": "Pakistani Drama"})
    assert r.status_code == 200, r.text

    new_folder = str(root / "Pakistani Drama" / "Playlist A")
    assert r.json()["download_dir"] == new_folder
    assert os.path.exists(os.path.join(new_folder, "one.m4a"))
    assert not os.path.exists(folder)


def test_subscription_folder_change_refuses_existing_name(client, root):
    folder = str(root / "Music" / "Playlist A")
    _touch(os.path.join(folder, "one.m4a"))
    _touch(str(root / "Other" / "Playlist A" / "keep.m4a"))

    async def seed(session):
        sub = Subscription(url="https://example.test/plA2", title="Playlist A", download_dir=folder)
        session.add(sub)
        await session.commit()
        return sub.id

    sub_id = _db(seed)
    r = client.patch(f"/api/subscriptions/{sub_id}", json={"download_folder": "Other"})
    assert r.status_code == 409
    assert os.path.exists(os.path.join(folder, "one.m4a"))


# ── destinations: default folder and per-download folder ─────────────────────

def test_default_folder_setting_is_used_when_nothing_is_picked(client, root):
    r = client.put("/api/settings", json={"settings": {"download_folder": "Music"}})
    assert r.status_code == 200
    assert (root / "Music").is_dir()

    dl = client.post("/api/downloads", json={"url": "https://example.test/a", "title": "A"})
    assert dl.status_code == 201
    assert dl.json()["output_path"] is None
    assert _download(dl.json()["id"])["output_dir"] == str(root / "Music")


def test_per_download_folder_overrides_default(client, root):
    client.put("/api/settings", json={"settings": {"download_folder": "Music"}})
    dl = client.post("/api/downloads", json={"url": "https://example.test/b", "title": "B",
                                             "output_folder": "Pakistani Drama"})
    assert dl.status_code == 201
    assert _download(dl.json()["id"])["output_dir"] == str(root / "Pakistani Drama")


def test_destination_outside_root_is_rejected(client, root):
    r = client.post("/api/downloads", json={"url": "https://example.test/c", "title": "C",
                                            "output_folder": "../escape"})
    assert r.status_code == 400
    assert not (root.parent / "escape").exists()


def test_default_setting_outside_root_is_rejected(client, root):
    r = client.put("/api/settings", json={"settings": {"download_folder": "../elsewhere"}})
    assert r.status_code == 400


def test_disk_move_is_reversed_when_library_update_fails(root, monkeypatch):
    from app.services import storage

    src = _touch(str(root / "A" / "f.mp4"))
    (root / "B").mkdir()
    dst = str(root / "B" / "f.mp4")

    async def failing_repoint(session, old, new):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(storage, "_repoint", failing_repoint)

    async def run(session):
        with pytest.raises(RuntimeError):
            await storage.move_entry(session, src, dst)

    _db(run)
    assert os.path.exists(src)
    assert not os.path.exists(dst)


def test_legacy_settings_default_means_the_root():
    from app.services.storage import normalize_rel

    assert normalize_rel("./downloads") == ""
    assert normalize_rel("Music/") == "Music"


def test_raw_download_is_an_attachment_and_inline_stays_inline(client, root):
    (root / "Show").mkdir()
    (root / "Show" / "ep1.mp4").write_bytes(b"data")
    r = client.get("/api/files/raw", params={"path": "Show/ep1.mp4", "download": "1"})
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.content == b"data"
    r = client.get("/api/files/raw", params={"path": "Show/ep1.mp4"})
    assert "attachment" not in r.headers.get("content-disposition", "")
