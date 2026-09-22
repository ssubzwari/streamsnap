"""Album art for audio downloads.

Plex reads album art from `cover.jpg` in the album's folder. Nothing else in the
app provides it — the TMDB artwork path covers *show* folders and TMDB has no
music artists, and yt-dlp's Embed Thumbnail option is off by default — so
without this an audio download arrives with no art at all.
"""

import os

from app.ytdl.artwork import write_music_cover
from app.ytdl.service import _write_audio_cover

# A 1x1 JPEG. Small enough to inline, real enough that a copy is a real copy.
JPEG = bytes([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, *([0x08] * 64),
    0xFF, 0xC9, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
    0x00, 0xFF, 0xCC, 0x00, 0x06, 0x00, 0x10, 0x10, 0x05, 0xFF, 0xDA, 0x00,
    0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20, 0xFF, 0xD9,
])


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def read(self, n=-1):
        data, self._data = self._data, b""
        return data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stub_fetch(monkeypatch, data=JPEG):
    """Intercept the thumbnail fetch — these tests are about file handling."""
    import urllib.request

    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(getattr(req, "full_url", req))
        return _FakeResponse(data)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


# ── Writing the cover ─────────────────────────────────────────────────────────

def test_writes_cover_jpg_into_the_album_folder(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch)
    written = write_music_cover(str(tmp_path), "https://i.ytimg.com/vi/abc/maxres.jpg")

    assert written == str(tmp_path / "cover.jpg")
    assert (tmp_path / "cover.jpg").read_bytes() == JPEG


def test_only_fetches_once_per_folder(monkeypatch, tmp_path):
    """An album of forty tracks should fetch one image, not forty."""
    calls = _stub_fetch(monkeypatch)

    first = write_music_cover(str(tmp_path), "https://i.ytimg.com/vi/abc/1.jpg")
    second = write_music_cover(str(tmp_path), "https://i.ytimg.com/vi/def/2.jpg")

    assert first is not None
    assert second is None          # already covered — skipped
    assert len(calls) == 1         # and no second download


def test_overwrite_replaces_an_existing_cover(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch)
    write_music_cover(str(tmp_path), "https://i.ytimg.com/vi/abc/1.jpg")

    _stub_fetch(monkeypatch, b"\xff\xd8\xffREPLACED")
    written = write_music_cover(
        str(tmp_path), "https://i.ytimg.com/vi/def/2.jpg", overwrite=True
    )

    assert written is not None
    assert (tmp_path / "cover.jpg").read_bytes() == b"\xff\xd8\xffREPLACED"


def test_missing_url_or_folder_is_a_no_op(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch)
    assert write_music_cover(str(tmp_path), None) is None
    assert write_music_cover(str(tmp_path), "") is None
    assert write_music_cover(str(tmp_path / "nope"), "https://x/y.jpg") is None


def test_a_failed_fetch_leaves_the_folder_untouched(monkeypatch, tmp_path):
    """Art is best-effort — a dead thumbnail URL must not leave a broken file."""
    import urllib.error
    import urllib.request

    def boom(req, timeout=None):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(urllib.request, "urlopen", boom)

    assert write_music_cover(str(tmp_path), "https://i.ytimg.com/vi/abc/1.jpg") is None
    assert list(tmp_path.iterdir()) == []


# ── The download hook ─────────────────────────────────────────────────────────

def test_audio_downloads_get_a_cover(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch)
    track = tmp_path / "Phil Collins - Sussudio.flac"
    track.write_bytes(b"")

    _write_audio_cover(str(track), {"thumbnail": "https://i.ytimg.com/vi/abc/1.jpg"})

    assert (tmp_path / "cover.jpg").exists()


def test_every_audio_container_is_covered(monkeypatch, tmp_path):
    """Sidecar art is format-independent — that is the point of using it."""
    for ext in (".flac", ".m4a", ".opus", ".mp3", ".ogg"):
        folder = tmp_path / ext.lstrip(".")
        folder.mkdir()
        track = folder / f"track{ext}"
        track.write_bytes(b"")

        _stub_fetch(monkeypatch)
        _write_audio_cover(str(track), {"thumbnail": "https://i.ytimg.com/vi/abc/1.jpg"})

        assert (folder / "cover.jpg").exists(), f"{ext} got no cover"


def test_video_downloads_are_skipped(monkeypatch, tmp_path):
    calls = _stub_fetch(monkeypatch)
    clip = tmp_path / "Some Video.mkv"
    clip.write_bytes(b"")

    _write_audio_cover(str(clip), {"thumbnail": "https://i.ytimg.com/vi/abc/1.jpg"})

    assert not calls
    assert not (tmp_path / "cover.jpg").exists()


def test_the_hook_never_raises(monkeypatch, tmp_path):
    """It runs at the end of run_download — an exception here would report a
    finished download as failed."""
    import app.ytdl.artwork as artwork_mod

    def boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(artwork_mod, "write_music_cover", boom)

    track = tmp_path / "track.flac"
    track.write_bytes(b"")
    _write_audio_cover(str(track), {"thumbnail": "https://x/y.jpg"})  # must not raise
