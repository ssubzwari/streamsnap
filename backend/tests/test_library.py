"""Library actions on completed downloads: bulk move/delete, rescan, import."""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import engine, get_sessionmaker
from app.main import app
from app.models import Download
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
    return str(path)


def _row(title, path):
    async def fn(session):
        row = Download(url=f"u-{title}", title=title, status="completed", percent=100.0,
                       format_spec="best", output_path=path,
                       output_dir=os.path.dirname(path) if path else None)
        session.add(row)
        await session.commit()
        return row.id

    return _db(fn)


def _read(download_id):
    async def fn(session):
        row = await session.get(Download, download_id)
        return None if row is None else {"output_path": row.output_path, "output_dir": row.output_dir}

    return _db(fn)


def test_bulk_move_repoints_each_row(client, root):
    a = _touch(root / "Show" / "a.mp4")
    b = _touch(root / "Show" / "b.mp4")
    _touch(root / "Dest" / ".keep")
    ida, idb = _row("a", a), _row("b", b)

    r = client.post("/api/library/move", json={"ids": [ida, idb], "folder": "Dest"})
    assert all(x["ok"] for x in r.json()["results"]), r.json()

    assert os.path.exists(root / "Dest" / "a.mp4") and not os.path.exists(a)
    assert _read(ida) == {"output_path": str(root / "Dest" / "a.mp4"), "output_dir": str(root / "Dest")}


def test_bulk_move_skips_name_clash(client, root):
    src = _touch(root / "A" / "same.mp4", "source")
    _touch(root / "B" / "same.mp4", "existing")
    dl = _row("same", src)

    r = client.post("/api/library/move", json={"ids": [dl], "folder": "B"})
    assert r.json()["results"][0]["ok"] is False
    assert (root / "B" / "same.mp4").read_text() == "existing"
    assert (root / "A" / "same.mp4").exists()


def test_bulk_delete_with_files_removes_file_and_row(client, root):
    p = _touch(root / "x" / "gone.mp4")
    dl = _row("gone", p)

    r = client.post("/api/library/delete", json={"ids": [dl], "delete_files": True})
    assert r.json()["results"][0]["ok"]
    assert not os.path.exists(p)
    assert _read(dl) is None


def test_bulk_delete_without_files_keeps_file(client, root):
    p = _touch(root / "x" / "kept.mp4")
    dl = _row("kept", p)

    client.post("/api/library/delete", json={"ids": [dl], "delete_files": False})
    assert os.path.exists(p)
    assert _read(dl) is None


def test_rescan_relinks_a_file_moved_outside_the_app(client, root):
    original = _touch(root / "Old" / "Episode 1.mp4")
    dl = _row("Episode 1", original)
    os.remove(original)
    moved = _touch(root / "New Home" / "Episode 1.mp4")

    report = client.post("/api/library/rescan").json()
    assert {"id": dl, "title": "Episode 1", "path": "New Home/Episode 1.mp4"} in report["relinked"]
    assert _read(dl)["output_path"] == moved


def test_rescan_lists_unlinked_media_and_import_adds_it(client, root):
    _touch(root / "Loose" / "orphan.mp3")
    report = client.post("/api/library/rescan").json()
    assert "Loose/orphan.mp3" in report["unlinked"]

    r = client.post("/api/library/import", json={"paths": ["Loose/orphan.mp3"]})
    assert len(r.json()["created"]) == 1
    assert client.post("/api/library/rescan").json()["unlinked"] == []


def test_import_refuses_paths_outside_root(client, root):
    r = client.post("/api/library/import", json={"paths": ["../etc/passwd"]})
    assert r.status_code == 400
