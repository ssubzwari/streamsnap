"""Exporting selected downloads as a playlist file.

Plex has no built-in M3U import for music — people use a third-party tool or
the API — and the thing that defeats every one of those is paths. A playlist
naming the files the way *StreamSnap* sees them imports as an empty playlist
when Plex has the same folder mounted somewhere else, which is the normal case
in Docker. So the path handling is what most of these tests are about.
"""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import get_sessionmaker
from app.main import app
from app.models import Download
from app.services.playlist_export import (
    Track,
    build_m3u,
    export_playlist,
    remap,
    safe_playlist_name,
)
from app.ytdl.tagging import write_tags


def _reset() -> None:
    async def run() -> None:
        from sqlalchemy import delete

        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            await s.commit()

    asyncio.run(run())


def _row(**kw) -> int:
    async def run() -> int:
        S = get_sessionmaker()
        async with S() as s:
            d = Download(status="completed", percent=100.0, **kw)
            s.add(d)
            await s.flush()
            did = d.id
            await s.commit()
            return did

    return asyncio.run(run())


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DOWNLOAD_DIR", str(tmp_path))
    _reset()
    yield str(tmp_path)
    _reset()


def _make_flac(path: str, **tags) -> str:
    """A real FLAC so read_tags() has something true to read."""
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        pytest.skip("needs ffmpeg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", "anullsrc=r=44100:cl=stereo", "-t", "0.2", path],
        check=True,
    )
    if tags:
        write_tags(path, tags)
    return path


# ── Path rewriting: the part that decides whether Plex sees anything ─────────

def test_remap_rewrites_only_the_mount_prefix():
    assert remap("/downloads/Music/a.flac", "/downloads", "/data/media") == "/data/media/Music/a.flac"
    # A trailing slash on the prefix must not double up.
    assert remap("/downloads/a.flac", "/downloads/", "/data/") == "/data/a.flac"


def test_remap_only_matches_at_the_start():
    """A prefix is a mount point. Replacing it mid-path would corrupt any file
    whose name happens to contain the same text."""
    path = "/music/downloads-archive/downloads/x.flac"
    assert remap(path, "/downloads", "/data") == path


def test_remap_does_not_match_a_partial_folder_name():
    """/down must not match /downloads."""
    assert remap("/downloads/a.flac", "/down", "/x") == "/downloads/a.flac"


def test_remap_is_a_no_op_without_a_mapping():
    assert remap("/downloads/a.flac", None, None) == "/downloads/a.flac"
    assert remap("/downloads/a.flac", "", "/data") == "/downloads/a.flac"


def test_safe_playlist_name_strips_path_characters():
    assert safe_playlist_name("Top 100: 2026/best") == "Top 100_ 2026_best"
    assert safe_playlist_name("   ") == "playlist"
    assert safe_playlist_name("") == "playlist"


# ── The file itself ──────────────────────────────────────────────────────────

def test_m3u_header_and_track_lines():
    tracks = [
        Track(path="/m/a.flac", title="Pasoori", artist="Ali Sethi", album="Coke Studio", duration=241),
        Track(path="/m/b.flac", title="Kahani", artist="Kaifi Khalil", album="Coke Studio", duration=180),
    ]
    text = build_m3u("Mix", tracks, base_dir="/m")

    lines = text.splitlines()
    assert lines[0] == "#EXTM3U"
    assert lines[1] == "#PLAYLIST:Mix"
    assert "#EXTINF:241,Ali Sethi - Pasoori" in lines
    assert "/m/a.flac" in lines
    assert text.endswith("\n")


def test_the_album_is_only_declared_when_it_changes():
    """#EXTALB applies to what follows it; repeating it per track is noise."""
    tracks = [
        Track(path="/m/a.flac", title="A", album="One"),
        Track(path="/m/b.flac", title="B", album="One"),
        Track(path="/m/c.flac", title="C", album="Two"),
    ]
    text = build_m3u("Mix", tracks, base_dir="/m")
    assert text.count("#EXTALB:One") == 1
    assert text.count("#EXTALB:Two") == 1


def test_a_track_with_no_artist_still_has_a_label():
    text = build_m3u("Mix", [Track(path="/m/a.flac", title="Just A Title")], base_dir="/m")
    assert "#EXTINF:-1,Just A Title" in text


def test_paths_can_be_rewritten_for_the_other_machine():
    tracks = [Track(path="/downloads/Music/a.flac", title="A")]
    text = build_m3u(
        "Mix", tracks, base_dir="/downloads",
        prefix_from="/downloads", prefix_to="/data/media",
    )
    assert "/data/media/Music/a.flac" in text
    assert "/downloads/Music/a.flac" not in text


def test_relative_paths_are_available_but_not_the_default():
    tracks = [Track(path="/downloads/Music/a.flac", title="A")]
    assert "Music/a.flac" in build_m3u("Mix", tracks, base_dir="/downloads", relative=True)
    # Default keeps it absolute, which is what Plex imports need.
    assert "/downloads/Music/a.flac" in build_m3u("Mix", tracks, base_dir="/downloads")


# ── Writing it out ───────────────────────────────────────────────────────────

def test_export_reads_the_real_tags_off_the_files(root):
    folder = os.path.join(root, "Coke Studio")
    a = _make_flac(os.path.join(folder, "one.flac"),
                   title="Pasoori", artist="Ali Sethi", album="Coke Studio")
    b = _make_flac(os.path.join(folder, "two.flac"),
                   title="Kahani", artist="Kaifi Khalil", album="Coke Studio")

    result = export_playlist("Season 14", [(a, "row title", 241), (b, None, None)], folder=root)
    text = open(result.path, encoding="utf-8").read()

    assert result.tracks == 2
    # The file's own tags win over the download row's title.
    assert "#EXTINF:241,Ali Sethi - Pasoori" in text
    assert "#EXTINF:-1,Kaifi Khalil - Kahani" in text
    assert "row title" not in text


def test_a_missing_file_is_reported_not_written(root):
    good = _make_flac(os.path.join(root, "a.flac"), title="A", artist="X")
    result = export_playlist(
        "Mix", [(good, None, None), (os.path.join(root, "gone.flac"), "Gone", None)], folder=root
    )

    assert result.tracks == 1
    assert len(result.skipped) == 1
    assert "gone.flac" in result.skipped[0]["path"]
    assert "gone.flac" not in open(result.path, encoding="utf-8").read()


def test_the_cover_next_to_the_playlist_comes_from_the_tracks(root):
    folder = os.path.join(root, "Album")
    track = _make_flac(os.path.join(folder, "a.flac"), title="A", artist="X")
    with open(os.path.join(folder, "cover.jpg"), "wb") as fh:
        fh.write(b"\xff\xd8\xffCOVER")

    result = export_playlist("My Mix", [(track, None, None)], folder=root)

    assert result.cover is not None
    assert os.path.isfile(result.cover)
    assert open(result.cover, "rb").read() == b"\xff\xd8\xffCOVER"


def test_no_cover_is_not_an_error(root):
    track = _make_flac(os.path.join(root, "a.flac"), title="A")
    result = export_playlist("Mix", [(track, None, None)], folder=root)
    assert result.cover is None
    assert result.tracks == 1


def test_the_written_file_has_no_bom(root):
    """A BOM makes the first entry unreadable for some players."""
    track = _make_flac(os.path.join(root, "a.flac"), title="A")
    result = export_playlist("Mix", [(track, None, None)], folder=root)
    assert open(result.path, "rb").read(3) != b"\xef\xbb\xbf"


# ── Through the API ──────────────────────────────────────────────────────────

def test_the_endpoint_writes_a_playlist_in_the_given_order(root):
    paths = [
        _make_flac(os.path.join(root, f"{n}.flac"), title=n.upper(), artist="X")
        for n in ("a", "b", "c")
    ]
    ids = [_row(url=f"file://{p}", title=p, output_path=p, output_dir=root) for p in paths]

    with TestClient(app) as c:
        r = c.post("/api/library/playlist", json={
            "ids": [ids[2], ids[0], ids[1]],   # deliberately not sorted
            "name": "My Mix",
        })
        assert r.status_code == 200, r.text
        body = r.json()

    assert body["tracks"] == 3
    text = open(os.path.join(root, "My Mix.m3u8"), encoding="utf-8").read()
    order = [ln for ln in text.splitlines() if ln.endswith(".flac")]
    assert order == [paths[2], paths[0], paths[1]], "the user's order must be kept"


def test_the_endpoint_applies_the_path_mapping(root):
    track = _make_flac(os.path.join(root, "a.flac"), title="A", artist="X")
    did = _row(url="file://a", title="A", output_path=track, output_dir=root)

    with TestClient(app) as c:
        r = c.post("/api/library/playlist", json={
            "ids": [did], "name": "Mapped",
            "prefix_from": root, "prefix_to": "/data/music",
        })
        assert r.status_code == 200, r.text

    text = open(os.path.join(root, "Mapped.m3u8"), encoding="utf-8").read()
    assert "/data/music/a.flac" in text
    assert root not in text


def test_no_matching_downloads_is_a_clear_error(root):
    with TestClient(app) as c:
        r = c.post("/api/library/playlist", json={"ids": [9999], "name": "Nope"})
    assert r.status_code == 400
    assert "no matching" in r.json()["detail"].lower()


def test_the_playlist_cannot_escape_the_download_folder(root):
    track = _make_flac(os.path.join(root, "a.flac"), title="A")
    did = _row(url="file://a", title="A", output_path=track, output_dir=root)

    with TestClient(app) as c:
        r = c.post("/api/library/playlist", json={
            "ids": [did], "name": "Escape", "folder": "../../etc",
        })

    assert r.status_code in (400, 404), "a path outside the root must be refused"


def test_duration_is_read_from_the_file_when_the_row_has_none(root):
    """An imported file has no duration in the database, and #EXTINF:-1 hides
    track lengths in most players."""
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        pytest.skip("needs ffmpeg")

    path = os.path.join(root, "long.flac")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", "anullsrc=r=44100:cl=stereo", "-t", "12", path],
        check=True,
    )
    write_tags(path, {"title": "Long", "artist": "X"})

    result = export_playlist("Mix", [(path, None, None)], folder=root)
    assert "#EXTINF:12,X - Long" in open(result.path, encoding="utf-8").read()


def test_the_rows_duration_still_wins_when_it_has_one(root):
    """Cheaper than opening the file, and it is what the site reported."""
    path = _make_flac(os.path.join(root, "a.flac"), title="A", artist="X")
    result = export_playlist("Mix", [(path, None, 241)], folder=root)
    assert "#EXTINF:241,X - A" in open(result.path, encoding="utf-8").read()
