"""Repairing audio that is already on disk.

These tests run against **real audio files** generated with ffmpeg and read back
with mutagen, because the whole point of the repair pass is what ends up in the
file — a mock would prove nothing about that.

The bug being fixed: a greatest-hits playlist whose tracks each carry the album
they were originally released on shows up in Plex as one album per track. Plex
groups by ``(ALBUM, ALBUMARTIST)``, so the repair pass reads a folder as a whole
and writes one pair across it.
"""

import os
import shutil
import subprocess

import pytest

from app.models import Download
from app.services import music_repair
from app.services.music_repair import VARIOUS, repair_music
from app.ytdl.tagging import read_tags, write_tags

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="needs ffmpeg to make real audio files"
)

JPEG = bytes([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, *([0x08] * 64),
    0xFF, 0xC9, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
    0x00, 0xFF, 0xCC, 0x00, 0x06, 0x00, 0x10, 0x10, 0x05, 0xFF, 0xDA, 0x00,
    0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20, 0xFF, 0xD9,
])


def make_audio(path: str, seconds: float = 0.3) -> str:
    """A real, silent audio file in whatever container *path*'s suffix names."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"anullsrc=r=44100:cl=stereo", "-t", str(seconds), path],
        check=True,
    )
    return path


@pytest.fixture
async def session():
    """A DB session for the repair pass. The table is already wiped by the
    autouse fixture in conftest."""
    from app.db import engine, get_sessionmaker, init_db

    await init_db()
    async with get_sessionmaker()() as s:
        yield s
    await engine.dispose()


@pytest.fixture
def no_network(monkeypatch):
    """Art fetches must not reach the internet from a test."""
    monkeypatch.setattr(
        music_repair.artwork, "fetch_cover_bytes", lambda url: (JPEG, "image/jpeg")
    )
    written = []
    monkeypatch.setattr(
        music_repair.artwork,
        "write_music_cover",
        lambda folder, url, overwrite=False: written.append((folder, url, overwrite)) or
        open(os.path.join(folder, "cover.jpg"), "wb").write(JPEG),
    )
    return written


# ── The reported bug ──────────────────────────────────────────────────────────

HITS = [
    ("Phil Collins - In The Air Tonight.flac", "Phil Collins", "Face Value"),
    ("Phil Collins - Sussudio.flac", "Phil Collins", "No Jacket Required"),
    ("Phil Collins - Another Day In Paradise.flac", "Phil Collins", "...But Seriously"),
    ("Philip Bailey - Easy Lover.flac", "Philip Bailey", "Chinese Wall"),
]


def _build_hits(tmp_path):
    """A folder in exactly the state the user reported: every track a different
    album, which is one album per track in Plex."""
    folder = tmp_path / "Phil Collins Hits"
    for name, artist, album in HITS:
        path = make_audio(str(folder / name))
        write_tags(path, {
            "title": name.split(" - ")[1].rsplit(".", 1)[0],
            "artist": artist, "album": album, "album_artist": artist,
        })
    return folder


def test_the_folder_really_does_start_split(tmp_path):
    """Guard the premise — without this the fix below proves nothing."""
    folder = _build_hits(tmp_path)
    pairs = {
        (read_tags(str(folder / n))["album"], read_tags(str(folder / n))["album_artist"])
        for n, _, _ in HITS
    }
    assert len(pairs) == len(HITS)  # four files, four albums


@pytest.mark.asyncio
async def test_repair_collapses_the_folder_to_one_album(session, tmp_path, no_network):
    folder = _build_hits(tmp_path)

    report = await repair_music(session, str(tmp_path), apply=True)

    pairs = {
        (read_tags(str(folder / n))["album"], read_tags(str(folder / n))["album_artist"])
        for n, _, _ in HITS
    }
    assert pairs == {("Phil Collins Hits", "Phil Collins")}
    assert report["applied"] is True
    assert report["files_changed"] == len(HITS)
    assert report["errors"] == []


@pytest.mark.asyncio
async def test_repair_keeps_each_track_its_own_artist_and_title(
    session, tmp_path, no_network
):
    """Only the *album* artist is forced constant. Flattening the performers
    would lose real information."""
    folder = _build_hits(tmp_path)

    await repair_music(session, str(tmp_path), apply=True)

    assert read_tags(str(folder / HITS[3][0]))["artist"] == "Philip Bailey"
    assert read_tags(str(folder / HITS[0][0]))["title"] == "In The Air Tonight"


# ── Dry run ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_dry_run_changes_nothing_on_disk(session, tmp_path, no_network):
    folder = _build_hits(tmp_path)
    before = {n: read_tags(str(folder / n)) for n, _, _ in HITS}

    report = await repair_music(session, str(tmp_path))          # apply defaults off

    assert report["applied"] is False
    assert {n: read_tags(str(folder / n)) for n, _, _ in HITS} == before


@pytest.mark.asyncio
async def test_a_dry_run_reports_what_it_would_do(session, tmp_path, no_network):
    _build_hits(tmp_path)
    report = await repair_music(session, str(tmp_path))

    assert report["files_scanned"] == len(HITS)
    assert report["files_changed"] == len(HITS)
    [entry] = report["folders"]
    assert entry["album"] == "Phil Collins Hits"
    assert entry["album_artist"] == "Phil Collins"
    # Each listed file says which fields move, so the UI can show a real diff.
    names = {f["name"] for f in entry["files"]}
    assert names == {n for n, _, _ in HITS}
    assert all("album" in f["changes"] for f in entry["files"])


@pytest.mark.asyncio
async def test_a_folder_already_correct_reports_no_changes(
    session, tmp_path, no_network
):
    """Running it twice must be a no-op — it is safe to re-run."""
    _build_hits(tmp_path)
    await repair_music(session, str(tmp_path), apply=True)

    again = await repair_music(session, str(tmp_path))
    assert again["files_changed"] == 0
    assert again["folders"] == []


# ── Choosing the album artist ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_mixed_folder_becomes_various_artists(session, tmp_path, no_network):
    """A different singer on every track really is a compilation. "Various
    Artists" is both honest and a single consistent album."""
    folder = tmp_path / "Coke Studio Season 14"
    for artist, track in [("Ali Sethi", "Pasoori"), ("Atif Aslam", "Wohi Khuda Hai"),
                          ("Kaifi Khalil", "Kahani")]:
        path = make_audio(str(folder / f"{artist} - {track}.flac"))
        write_tags(path, {"artist": artist, "title": track, "album": f"{track} (Single)"})

    await repair_music(session, str(tmp_path), apply=True)

    tags = [read_tags(str(folder / n)) for n in sorted(os.listdir(folder))]
    assert {t["album"] for t in tags} == {"Coke Studio Season 14"}
    assert {t["album_artist"] for t in tags} == {VARIOUS}
    assert {t["artist"] for t in tags} == {"Ali Sethi", "Atif Aslam", "Kaifi Khalil"}


@pytest.mark.asyncio
async def test_one_guest_track_does_not_cost_the_artist_their_album(
    session, tmp_path, no_network
):
    """Three of four tracks are Phil Collins, so the album stays his rather
    than being demoted to a compilation."""
    folder = _build_hits(tmp_path)
    await repair_music(session, str(tmp_path), apply=True)
    assert read_tags(str(folder / HITS[0][0]))["album_artist"] == "Phil Collins"


# ── Artwork ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_each_file_gets_its_own_embedded_art_from_its_download_row(
    session, tmp_path, monkeypatch
):
    """Per-track art is the thing a single shared cover cannot do, so it has to
    come from each file's own row."""
    folder = _build_hits(tmp_path)
    for i, (name, _, _) in enumerate(HITS):
        session.add(Download(
            url=f"https://youtu.be/vid{i}", status="completed",
            output_path=str(folder / name), thumbnail=f"https://i.ytimg.com/vi/{i}/m.jpg",
        ))
    await session.commit()

    seen = []

    def fake_fetch(url):
        seen.append(url)
        # A distinct image per track, so the files cannot accidentally match.
        return JPEG + url.encode(), "image/jpeg"

    monkeypatch.setattr(music_repair.artwork, "fetch_cover_bytes", fake_fetch)
    monkeypatch.setattr(
        music_repair.artwork, "write_music_cover",
        lambda folder, url, overwrite=False: None,
    )

    await repair_music(session, str(tmp_path), apply=True)

    assert sorted(seen) == sorted(f"https://i.ytimg.com/vi/{i}/m.jpg" for i in range(4))

    from mutagen.flac import FLAC
    pictures = [FLAC(str(folder / n)).pictures[0].data for n, _, _ in HITS]
    assert len({bytes(p) for p in pictures}) == len(HITS)  # all different


@pytest.mark.asyncio
async def test_cover_jpg_is_written_once_for_the_folder(session, tmp_path, no_network):
    folder = _build_hits(tmp_path)
    session.add(Download(
        url="https://youtu.be/x", status="completed",
        output_path=str(folder / HITS[0][0]), thumbnail="https://i.ytimg.com/vi/x/m.jpg",
    ))
    await session.commit()

    report = await repair_music(session, str(tmp_path), apply=True)

    assert (folder / "cover.jpg").exists()
    assert report["covers_written"] == 1
    assert len(no_network) == 1          # one write for four tracks


@pytest.mark.asyncio
async def test_an_existing_cover_is_left_alone_unless_asked(
    session, tmp_path, no_network
):
    folder = _build_hits(tmp_path)
    (folder / "cover.jpg").write_bytes(b"\xff\xd8\xffMINE")
    session.add(Download(
        url="https://youtu.be/x", status="completed",
        output_path=str(folder / HITS[0][0]), thumbnail="https://i.ytimg.com/vi/x/m.jpg",
    ))
    await session.commit()

    await repair_music(session, str(tmp_path), apply=True)
    assert (folder / "cover.jpg").read_bytes() == b"\xff\xd8\xffMINE"

    await repair_music(session, str(tmp_path), apply=True, overwrite_cover=True)
    assert (folder / "cover.jpg").read_bytes() != b"\xff\xd8\xffMINE"


def test_cover_jpg_is_never_treated_as_a_track(tmp_path, no_network):
    """The sidecars this app writes are not music and must not be scanned."""
    folder = tmp_path / "Album"
    folder.mkdir()
    (folder / "cover.jpg").write_bytes(JPEG)
    (folder / "poster.jpg").write_bytes(JPEG)
    assert music_repair._audio_files(str(folder)) == []


# ── Robustness ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_video_files_are_untouched(session, tmp_path, no_network):
    folder = tmp_path / "Show"
    make_audio(str(folder / "Episode 1.mp4"))
    report = await repair_music(session, str(tmp_path), apply=True)
    assert report["files_scanned"] == 0


@pytest.mark.asyncio
async def test_nested_folders_are_each_their_own_album(session, tmp_path, no_network):
    for album, artist in [("Face Value", "Phil Collins"), ("Thriller", "Michael Jackson")]:
        path = make_audio(str(tmp_path / "Music" / album / f"{artist} - A Song.flac"))
        write_tags(path, {"artist": artist, "title": "A Song", "album": "Wrong"})

    await repair_music(session, str(tmp_path), apply=True)

    base = tmp_path / "Music"
    assert read_tags(str(base / "Face Value" / "Phil Collins - A Song.flac"))["album"] \
        == "Face Value"
    assert read_tags(str(base / "Thriller" / "Michael Jackson - A Song.flac"))["album"] \
        == "Thriller"


@pytest.mark.asyncio
async def test_one_unreadable_file_does_not_stop_the_folder(
    session, tmp_path, no_network
):
    folder = _build_hits(tmp_path)
    broken = folder / "Not Really Audio.flac"
    broken.write_bytes(b"this is not a flac file")

    report = await repair_music(session, str(tmp_path), apply=True)

    assert len(report["errors"]) == 1
    assert report["errors"][0]["path"] == str(broken)
    # The real tracks were still repaired.
    assert read_tags(str(folder / HITS[0][0]))["album"] == "Phil Collins Hits"


@pytest.mark.asyncio
async def test_every_writable_container_is_repaired(session, tmp_path, no_network):
    """The split is container-independent, so the repair has to be too."""
    folder = tmp_path / "Mixed Bag"
    for ext in (".flac", ".mp3", ".m4a", ".ogg", ".opus"):
        path = make_audio(str(folder / f"Some Artist - Track{ext}"))
        write_tags(path, {"artist": "Some Artist", "album": "Wrong Album"})

    await repair_music(session, str(tmp_path), apply=True)

    for ext in (".flac", ".mp3", ".m4a", ".ogg", ".opus"):
        tags = read_tags(str(folder / f"Some Artist - Track{ext}"))
        assert tags["album"] == "Mixed Bag", ext
        assert tags["album_artist"] == "Some Artist", ext


@pytest.mark.asyncio
async def test_an_empty_root_is_not_an_error(session, tmp_path):
    report = await repair_music(session, str(tmp_path))
    assert report["files_scanned"] == 0
    assert report["folders"] == []
