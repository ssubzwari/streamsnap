"""Media Manager roots: validation, listing, mutations across roots."""

import asyncio
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import engine, get_sessionmaker
from app.main import app
from app.models import Download, Setting
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
        _clear_media_folders()
        yield c
        _clear_media_folders()


@pytest.fixture
def extra(tmp_path):
    folder = tmp_path / "music"
    folder.mkdir()
    return folder


def _db(fn):
    async def run():
        async with get_sessionmaker()() as session:
            return await fn(session)

    try:
        return asyncio.run(run())
    finally:
        asyncio.run(engine.dispose())


def _clear_media_folders():
    async def fn(session):
        row = await session.get(Setting, "media_folders")
        if row:
            await session.delete(row)
            await session.commit()

    _db(fn)


def _touch(path, text="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    return str(path)


def _seed(**fields):
    async def fn(session):
        row = Download(url="https://example.test/v", format_spec="best", **fields)
        session.add(row)
        await session.commit()
        return row.id

    return _db(fn)


def _row(download_id):
    async def fn(session):
        row = await session.get(Download, download_id)
        return row.output_path if row else "MISSING"

    return _db(fn)


def _save(client, folders):
    return client.put("/api/settings", json={"settings": {"media_folders": json.dumps(folders)}})


# ── roots + validation ───────────────────────────────────────────────────────

def test_roots_without_media_folders(client, root):
    _touch(root / "a.mp4")
    roots = client.get("/api/media/roots").json()["roots"]
    assert roots == [{"id": "0", "label": "Downloads", "path": str(root), "available": True, "file_count": 1}]


def test_roots_with_media_folders_and_missing_one(client, root, extra, tmp_path):
    _touch(extra / "s.mp3")
    assert _save(client, [str(extra)]).status_code == 200
    gone = tmp_path / "gone"
    gone.mkdir()
    assert _save(client, [str(extra), str(gone)]).status_code == 200
    gone.rmdir()
    roots = client.get("/api/media/roots").json()["roots"]
    assert [r["id"] for r in roots] == ["0", "1", "2"]
    assert roots[1]["available"] and roots[1]["file_count"] == 1
    assert roots[2]["available"] is False and roots[2]["file_count"] == 0
    assert client.get("/api/media/list", params={"root": "2"}).status_code == 409


@pytest.mark.parametrize("make", [
    lambda root, extra, tmp: [str(root)],
    lambda root, extra, tmp: [str(root / "sub")],
    lambda root, extra, tmp: [str(extra), str(extra)],
    lambda root, extra, tmp: [str(tmp / "nope")],
    lambda root, extra, tmp: ["relative/dir"],
])
def test_validation_rejects(client, root, extra, tmp_path, make):
    (root / "sub").mkdir()
    assert _save(client, make(root, extra, tmp_path)).status_code == 400
    assert client.get("/api/media/roots").json()["roots"][1:] == []


def test_validation_rejects_non_list(client):
    r = client.put("/api/settings", json={"settings": {"media_folders": "{\"a\": 1}"}})
    assert r.status_code == 400


def test_unknown_root_is_404(client):
    assert client.get("/api/media/list", params={"root": "9"}).status_code == 404


# ── listing ──────────────────────────────────────────────────────────────────

def test_listing_sorts_classifies_and_marks_downloads(client, root, tmp_path):
    video = _touch(root / "b.MP4")
    _touch(root / "a.mp3")
    _touch(root / "notes.txt")
    _touch(root / ".hidden")
    (root / "Zed").mkdir()
    (root / "alpha").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, root / "escape")
    did = _seed(status="completed", output_path=video)

    body = client.get("/api/media/list", params={"root": "0", "path": ""}).json()
    assert body["parent"] is None
    assert [(e["name"], e["kind"]) for e in body["entries"]] == [
        ("alpha", "folder"), ("Zed", "folder"), ("a.mp3", "audio"), ("b.MP4", "video"), ("notes.txt", "other"),
    ]
    by_name = {e["name"]: e for e in body["entries"]}
    assert by_name["b.MP4"]["download_id"] == did and by_name["a.mp3"]["download_id"] is None
    assert by_name["alpha"]["size"] is None and by_name["a.mp3"]["size"] == 1
    assert by_name["a.mp3"]["modified"].endswith("+00:00")

    sub = client.get("/api/media/list", params={"path": "alpha"}).json()
    assert sub["parent"] == ""


# ── escapes ──────────────────────────────────────────────────────────────────

def test_escapes_refused_everywhere(client, root, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    _touch(outside / "secret.txt")
    os.symlink(outside, root / "escape")
    _touch(root / "ok.txt")
    (root / "dest").mkdir()

    for bad in ("../", "escape", "escape/secret.txt"):
        assert client.get("/api/media/list", params={"path": bad}).status_code == 400
        assert client.post("/api/media/folders", json={"path": bad, "name": "x"}).status_code == 400
        assert client.post("/api/media/rename", json={"path": bad, "new_name": "y"}).status_code == 400
        for mode in ("move", "copy"):
            r = client.post("/api/media/transfer", json={"items": [bad], "dest": "dest", "mode": mode})
            assert r.status_code == 200 and not r.json()["results"][0]["ok"]
        r = client.post("/api/media/delete", json={"items": [bad]})
        assert not r.json()["results"][0]["ok"]
    # destination escape
    assert client.post("/api/media/transfer", json={"items": ["ok.txt"], "dest": "escape"}).status_code == 400
    assert (outside / "secret.txt").exists() and os.path.islink(root / "escape")


def test_bad_names_rejected(client):
    for bad in ("..", "a/b", ""):
        assert client.post("/api/media/folders", json={"path": "", "name": bad}).status_code == 400


# ── mutations ────────────────────────────────────────────────────────────────

def test_create_folder_in_extra_root(client, extra):
    _save(client, [str(extra)])
    r = client.post("/api/media/folders", json={"root": "1", "path": "", "name": "New"})
    assert r.status_code == 201 and r.json()["path"] == "New"
    assert (extra / "New").is_dir()
    assert client.post("/api/media/folders", json={"root": "1", "path": "", "name": "New"}).status_code == 409


def test_rename_repoints_download(client, root):
    src = _touch(root / "a.mp4")
    did = _seed(status="completed", output_path=src)
    r = client.post("/api/media/rename", json={"root": "0", "path": "a.mp4", "new_name": "b.mp4"})
    assert r.status_code == 200 and r.json()["path"] == "b.mp4"
    assert _row(did) == str(root / "b.mp4")


def test_rename_refused_while_download_active(client, root):
    src = _touch(root / "a.mp4")
    _seed(status="downloading", output_path=src)
    r = client.post("/api/media/rename", json={"path": "a.mp4", "new_name": "b.mp4"})
    assert r.status_code == 409 and os.path.exists(src)


def test_move_across_roots_updates_row_and_copy_leaves_it(client, root, extra):
    _save(client, [str(extra)])
    src = _touch(root / "Show" / "ep.mp4")
    did = _seed(status="completed", output_path=src)

    r = client.post("/api/media/transfer", json={"root": "0", "items": ["Show/ep.mp4"], "dest_root": "1", "dest": "", "mode": "copy"})
    assert r.json()["results"][0]["ok"]
    assert (extra / "ep.mp4").exists() and os.path.exists(src) and _row(did) == src

    os.remove(extra / "ep.mp4")
    r = client.post("/api/media/transfer", json={"root": "0", "items": ["Show/ep.mp4"], "dest_root": "1", "dest": "", "mode": "move"})
    assert r.json()["results"][0]["new_path"] == "ep.mp4"
    assert not os.path.exists(src)
    assert _row(did) == str(extra / "ep.mp4")


def test_move_refused_while_download_active(client, root, extra):
    _save(client, [str(extra)])
    src = _touch(root / "a.mp4")
    _seed(status="downloading", output_path=src)
    r = client.post("/api/media/transfer", json={"items": ["a.mp4"], "dest_root": "1", "mode": "move"})
    assert not r.json()["results"][0]["ok"] and os.path.exists(src)


def test_transfer_validation(client, root):
    assert client.post("/api/media/transfer", json={"items": [], "mode": "zap"}).status_code == 400
    assert client.post("/api/media/transfer", json={"items": [], "dest_root": "7"}).status_code == 404
    assert client.post("/api/media/transfer", json={"items": [], "dest": "missing"}).status_code == 404


def test_delete_keeps_download_row_and_clears_output_path(client, root):
    src = _touch(root / "Show" / "ep.mp4")
    did = _seed(status="completed", output_path=src)
    r = client.post("/api/media/delete", json={"root": "0", "items": ["Show"]})
    assert r.json()["results"][0]["ok"]
    assert not (root / "Show").exists()
    assert _row(did) is None


def test_mutations_on_unavailable_root_are_409(client, tmp_path):
    gone = tmp_path / "gone"
    gone.mkdir()
    _save(client, [str(gone)])
    gone.rmdir()
    assert client.post("/api/media/folders", json={"root": "1", "name": "x"}).status_code == 409
    assert client.post("/api/media/rename", json={"root": "1", "path": "a", "new_name": "b"}).status_code == 409
    assert client.post("/api/media/delete", json={"root": "1", "items": ["a"]}).status_code == 409
    assert client.post("/api/media/transfer", json={"root": "0", "items": [], "dest_root": "1"}).status_code == 409
