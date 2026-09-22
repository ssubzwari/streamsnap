"""Write music tags into a downloaded audio file.

mutagen edits tags in place — no re-encode, no temporary file, no extra
process — across every container yt-dlp produces for audio-only downloads.
Each format keeps its own tag vocabulary, so the shared field names produced by
:func:`app.ytdl.trackinfo.derive_tags` are mapped per container below.

Cover art is embedded here too, per track — each song carries its own image,
which is what a music player shows while it plays. That is separate from the
folder's ``cover.jpg`` (see :mod:`app.ytdl.artwork`), which is what Plex uses
for the *album*.
"""

import logging
import os

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, TALB, TCON, TDRC, TIT2, TPE1, TPE2, TRCK
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

logger = logging.getLogger(__name__)


class TaggingError(Exception):
    """The file could not be tagged (unsupported container, unreadable file)."""


def _track_pair(tags: dict) -> str:
    """``"3/12"`` when the total is known, else ``"3"`` — the Vorbis/ID3 form."""
    number = tags["track_number"]
    total = tags.get("track_total")
    return f"{number}/{total}" if total else str(number)


def _picture(cover: bytes, mime: str) -> Picture:
    """A FLAC/Vorbis picture block — front cover, type 3."""
    pic = Picture()
    pic.data = cover
    pic.type = 3
    pic.mime = mime
    return pic


# ── Per-container writers ─────────────────────────────────────────────────────

def _write_mp4(path: str, tags: dict, cover: bytes | None, mime: str) -> None:
    audio = MP4(path)
    atoms = {
        "title": "\xa9nam",
        "artist": "\xa9ART",
        "album": "\xa9alb",
        "album_artist": "aART",
        "date": "\xa9day",
        "genre": "\xa9gen",
    }
    for field, atom in atoms.items():
        if field in tags:
            audio[atom] = [str(tags[field])]

    if "track_number" in tags:
        audio["trkn"] = [(int(tags["track_number"]), int(tags.get("track_total") or 0))]

    if cover:
        fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
        audio["covr"] = [MP4Cover(cover, imageformat=fmt)]

    audio.save()


def _write_mp3(path: str, tags: dict, cover: bytes | None, mime: str) -> None:
    audio = MP3(path)
    if audio.tags is None:
        audio.add_tags()
    id3 = audio.tags

    frames = {
        "title": TIT2,
        "artist": TPE1,
        "album": TALB,
        "album_artist": TPE2,
        "date": TDRC,
        "genre": TCON,
    }
    for field, frame in frames.items():
        if field in tags:
            id3.setall(frame.__name__, [frame(encoding=3, text=[str(tags[field])])])

    if "track_number" in tags:
        id3.setall("TRCK", [TRCK(encoding=3, text=[_track_pair(tags)])])

    if cover:
        # delall first: re-downloading over a tagged file must replace the
        # picture, not stack a second one.
        id3.delall("APIC")
        id3.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=cover))

    audio.save()


def _vorbis_fields(tags: dict) -> dict[str, str]:
    keys = {
        "title": "TITLE",
        "artist": "ARTIST",
        "album": "ALBUM",
        "album_artist": "ALBUMARTIST",
        "date": "DATE",
        "genre": "GENRE",
        "track_number": "TRACKNUMBER",
        "track_total": "TRACKTOTAL",
    }
    return {key: str(tags[field]) for field, key in keys.items() if field in tags}


def _write_ogg(path: str, tags: dict, cover: bytes | None, mime: str, opus: bool) -> None:
    import base64

    audio = OggOpus(path) if opus else OggVorbis(path)
    audio.update(_vorbis_fields(tags))
    if cover:
        audio["METADATA_BLOCK_PICTURE"] = [
            base64.b64encode(_picture(cover, mime).write()).decode("ascii")
        ]
    audio.save()


def _write_flac(path: str, tags: dict, cover: bytes | None, mime: str) -> None:
    audio = FLAC(path)
    audio.update(_vorbis_fields(tags))
    if cover:
        audio.clear_pictures()
        audio.add_picture(_picture(cover, mime))
    audio.save()


_WRITERS = {
    ".m4a": _write_mp4,
    ".m4b": _write_mp4,
    ".mp4": _write_mp4,
    ".mp3": _write_mp3,
    ".opus": lambda p, t, c, m: _write_ogg(p, t, c, m, opus=True),
    ".ogg": lambda p, t, c, m: _write_ogg(p, t, c, m, opus=False),
    ".oga": lambda p, t, c, m: _write_ogg(p, t, c, m, opus=False),
    ".flac": _write_flac,
}

SUPPORTED_EXTS = frozenset(_WRITERS)


def can_tag(path: str | None) -> bool:
    return bool(path) and os.path.splitext(path)[1].lower() in SUPPORTED_EXTS


def write_tags(
    path: str, tags: dict, cover: bytes | None = None, mime: str = "image/jpeg"
) -> None:
    """Write *tags* — and optionally embed *cover* — into the audio file at *path*.

    *cover* is this track's own artwork, not the album's; each file gets its own
    image. Re-tagging replaces the picture rather than adding a second one.

    Raises :class:`TaggingError` when the container isn't supported or mutagen
    can't parse the file.
    """
    writer = _WRITERS.get(os.path.splitext(path)[1].lower())
    if writer is None:
        raise TaggingError("unsupported container")
    if not tags:
        raise TaggingError("no tags to write")

    try:
        writer(path, tags, cover, mime)
    except Exception as exc:  # noqa: BLE001 — mutagen raises per-format errors
        raise TaggingError(f"tagging {os.path.basename(path)} failed: {exc}") from exc
