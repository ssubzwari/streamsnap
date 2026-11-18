"""Write a playlist file for the files already in the library.

**Plex has no built-in M3U import for music.** People do it with a third-party
tool (ListPorter, Plex Playlist Importer) or the API, and the thing that trips
every one of them up is paths: the playlist has to name the files the way the
*Plex server* sees them, which is rarely how StreamSnap sees them. A Plex in
Docker might mount the same folder as ``/data/music`` while StreamSnap writes
to ``/downloads``.

So this does two jobs. It writes a correct extended M3U8, and it rewrites the
paths inside it (``path_prefix_from`` → ``path_prefix_to``) so they match the
other machine. Without that the file imports as an empty playlist and nothing
says why.

Absolute paths are the default for the same reason — relative ones are what
most Plex import failures turn out to be.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass, field

from app.utils import is_audio_path
from app.ytdl.tagging import read_duration, read_tags

logger = logging.getLogger(__name__)

# Written next to the playlist. Not read by Plex — see `cover` in the result.
_COVER_CANDIDATES = ("cover.jpg", "cover.png", "folder.jpg", "poster.jpg")


@dataclass
class Track:
    path: str
    title: str
    artist: str | None = None
    album: str | None = None
    duration: int = -1  # -1 is the extended-M3U "unknown" value

    @property
    def label(self) -> str:
        """The ``#EXTINF`` display text: "Artist - Title", or just the title."""
        return f"{self.artist} - {self.title}" if self.artist else self.title


@dataclass
class ExportResult:
    path: str
    name: str
    tracks: int
    skipped: list[dict] = field(default_factory=list)
    cover: str | None = None


def safe_playlist_name(name: str) -> str:
    """A file name that is safe on Windows and Linux alike."""
    import re

    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:120] or "playlist"


def remap(path: str, prefix_from: str | None, prefix_to: str | None) -> str:
    """Rewrite *path* from this machine's view to the other machine's.

    Only a leading match is replaced: a prefix is a mount point, and replacing
    it anywhere else in the path would corrupt file names that happen to
    contain the same text.
    """
    if not prefix_from or prefix_to is None:
        return path
    src = prefix_from.rstrip("/\\")
    if not src:
        return path
    # Compare with normalised separators so a Windows-style prefix still
    # matches a path stored with forward slashes.
    norm_path = path.replace("\\", "/")
    norm_src = src.replace("\\", "/")
    if norm_path == norm_src:
        return prefix_to
    if norm_path.startswith(norm_src + "/"):
        return prefix_to.rstrip("/\\") + norm_path[len(norm_src):]
    return path


def _track_from(path: str, row_title: str | None, duration: int | None) -> Track:
    """Prefer the file's own tags; fall back to the download row, then the name.

    The tags are the better source precisely because music_repair has already
    reconciled them — artist and album there agree with what Plex will show.
    """
    tags = read_tags(path) if is_audio_path(path) else {}
    stem = os.path.splitext(os.path.basename(path))[0]
    # The row knows the duration for anything StreamSnap downloaded; a file
    # imported from disk does not, so fall back to reading the file.
    seconds = int(duration) if duration else (read_duration(path) or -1)
    return Track(
        path=path,
        title=tags.get("title") or row_title or stem,
        artist=tags.get("artist") or tags.get("album_artist"),
        album=tags.get("album"),
        duration=seconds,
    )


def _find_cover(tracks: list[Track]) -> str | None:
    """A cover image from the first track folder that has one."""
    seen: set[str] = set()
    for track in tracks:
        folder = os.path.dirname(track.path)
        if folder in seen:
            continue
        seen.add(folder)
        for name in _COVER_CANDIDATES:
            candidate = os.path.join(folder, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def build_m3u(
    name: str,
    tracks: list[Track],
    *,
    base_dir: str,
    relative: bool = False,
    prefix_from: str | None = None,
    prefix_to: str | None = None,
) -> str:
    """The extended-M3U text. Pure, so it is easy to assert on."""
    lines = ["#EXTM3U", f"#PLAYLIST:{name}"]
    album_written: str | None = None

    for track in tracks:
        # #EXTALB applies to the entries that follow it, so only emit it when
        # the album actually changes — repeating it per track is noise.
        if track.album and track.album != album_written:
            lines.append(f"#EXTALB:{track.album}")
            album_written = track.album
        if track.artist:
            lines.append(f"#EXTART:{track.artist}")
        lines.append(f"#EXTINF:{track.duration},{track.label}")

        path = track.path
        if relative:
            try:
                path = os.path.relpath(path, base_dir).replace(os.sep, "/")
            except ValueError:
                pass  # different drive on Windows — keep it absolute
        else:
            path = remap(os.path.abspath(path), prefix_from, prefix_to)
        lines.append(path)

    return "\n".join(lines) + "\n"


def export_playlist(
    name: str,
    rows: list[tuple[str, str | None, int | None]],
    *,
    folder: str,
    relative: bool = False,
    prefix_from: str | None = None,
    prefix_to: str | None = None,
    write_cover: bool = True,
) -> ExportResult:
    """Write ``<name>.m3u8`` into *folder*.

    *rows* is ``(output_path, title, duration)`` per selected download. Rows
    whose file is missing are skipped and reported rather than written as dead
    entries — a playlist that half works is worse than one that says what it
    dropped.
    """
    safe = safe_playlist_name(name)
    os.makedirs(folder, exist_ok=True)

    tracks: list[Track] = []
    skipped: list[dict] = []
    for path, title, duration in rows:
        if not path or not os.path.isfile(path):
            skipped.append({"path": path or "", "reason": "file not found"})
            continue
        tracks.append(_track_from(path, title, duration))

    target = os.path.join(folder, f"{safe}.m3u8")
    text = build_m3u(
        safe, tracks,
        base_dir=folder, relative=relative,
        prefix_from=prefix_from, prefix_to=prefix_to,
    )
    # utf-8 with no BOM: the .m3u8 extension already declares the encoding, and
    # a BOM makes the first path unreadable for some players.
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)

    cover_out: str | None = None
    if write_cover and tracks:
        source = _find_cover(tracks)
        if source:
            try:
                cover_out = os.path.join(folder, f"{safe}{os.path.splitext(source)[1]}")
                if os.path.abspath(source) != os.path.abspath(cover_out):
                    shutil.copyfile(source, cover_out)
            except OSError as exc:  # noqa: BLE001 — art is best-effort
                logger.warning("playlist cover copy failed: %s", exc)
                cover_out = None

    return ExportResult(
        path=target, name=safe, tracks=len(tracks), skipped=skipped, cover=cover_out
    )
