"""Retag audio files that are already on disk.

Everything in :mod:`app.ytdl.trackinfo` runs at download time, with yt-dlp's
``info_dict`` in hand. Files downloaded before tagging existed — or before the
"a playlist is one album" rule existed — keep whatever tags they were written
with, and nothing goes back to fix them. This does.

It has one advantage the download path can never have: **it sees every file in
a folder at once.** ``derive_tags`` decides each file on its own and so cannot
tell that a folder's tracks disagree with each other; here the whole folder is
read first, one ``(album, album_artist)`` pair is chosen for it, and every file
is written to agree. That pair is what Plex groups an album by, so agreeing on
it is the difference between one album and forty-seven.

Three things are repaired, per folder:

* **tags** — title / artist / album / album artist / date / track number
* **embedded art** — this track's own image, from its ``downloads`` row
* ``cover.jpg`` — the album tile, once per folder

It is a **dry run by default**: nothing is written until ``apply=True``, and the
report is the same shape either way, so the UI can show exactly what would
change before anything does.
"""

from __future__ import annotations

import logging
import os
from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Download
from app.utils import is_audio_path
from app.ytdl import artwork
from app.ytdl.tagging import TaggingError, can_tag, read_tags, write_tags
from app.ytdl.trackinfo import clean_title, derive_tags, split_artist_title

logger = logging.getLogger(__name__)

# A folder is one artist's album when that artist sings most of it. Below this
# share it is a compilation, and "Various Artists" is both the honest answer and
# the one Plex expects. Phil Collins' hits with one guest track stay his; a
# Coke Studio season with a different singer every track does not.
_DOMINANT_SHARE = 2 / 3

VARIOUS = "Various Artists"

# Written by this app, never music.
_SKIP_NAMES = {"cover.jpg", "poster.jpg", "background.jpg", "logo.png",
               "square.jpg", "banner.jpg"}


@dataclass
class FilePlan:
    """What would change for one file."""

    path: str
    tags: dict
    current: dict
    embed_art: bool = False
    error: str | None = None

    @property
    def changes(self) -> dict:
        """Only the fields whose value would actually differ."""
        return {
            k: v for k, v in self.tags.items()
            if str(self.current.get(k) or "") != str(v)
        }

    @property
    def would_change(self) -> bool:
        return bool(self.changes) or self.embed_art


@dataclass
class FolderPlan:
    """What would change for one folder."""

    folder: str
    album: str | None = None
    album_artist: str | None = None
    files: list[FilePlan] = field(default_factory=list)
    cover: str | None = None
    write_cover: bool = False

    @property
    def changed_files(self) -> list[FilePlan]:
        return [f for f in self.files if f.would_change]


def _audio_files(folder: str) -> list[str]:
    """Taggable audio files directly in *folder*, sorted for a stable report."""
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return []
    out = []
    for name in names:
        if name.lower() in _SKIP_NAMES:
            continue
        path = os.path.join(folder, name)
        if os.path.isfile(path) and is_audio_path(path) and can_tag(path):
            out.append(path)
    return out


def _folders(root: str) -> list[str]:
    """*root* and every folder under it that holds audio, deepest last."""
    found = []
    for dirpath, dirnames, _ in os.walk(root):
        dirnames[:] = [d for d in sorted(dirnames) if not d.startswith(".")]
        if _audio_files(dirpath):
            found.append(dirpath)
    return found


def _info_from_row(row: Download | None, path: str) -> dict:
    """A stand-in ``info_dict`` built from the file's ``downloads`` row.

    A row carries the title the site gave and the video thumbnail, which is all
    the per-track information still available once the download is over. With no
    row the file name is all there is, which is what ``derive_tags`` falls back
    to anyway.
    """
    if row is None:
        return {}
    info: dict = {}
    if row.title:
        info["title"] = row.title
    if row.thumbnail:
        info["thumbnail"] = row.thumbnail
    return info


def _artist_of(path: str, tags: dict, current: dict) -> str | None:
    """Best guess at who performs this track, for the folder vote."""
    return (
        tags.get("artist")
        or current.get("artist")
        or split_artist_title(os.path.splitext(os.path.basename(path))[0])[0]
    )


def _reconcile(folder: str, rows: list[tuple[str, dict, dict]]) -> tuple[str, str]:
    """The one ``(album, album_artist)`` the whole folder should carry.

    The **folder name** is the album. It is what the user already sees in their
    library, it is the same for every file in it by definition, and it is right
    whether the folder is a playlist ("Phil Collins Hits") or a real album
    ("Face Value") — unlike the per-file ``ALBUM`` tags, which are exactly what
    split the folder apart.

    The album artist is then whoever performs most of it (see
    ``_DOMINANT_SHARE``), falling back to "Various Artists".
    """
    album = clean_title(os.path.basename(folder.rstrip(os.sep))) or os.path.basename(folder)

    artists = [a for a in (_artist_of(p, t, c) for p, t, c in rows) if a]
    if not artists:
        # Nothing names an artist anywhere — an existing consistent album artist
        # is better than inventing one.
        existing = {c.get("album_artist") for _, _, c in rows if c.get("album_artist")}
        return album, (existing.pop() if len(existing) == 1 else VARIOUS)

    top, count = Counter(artists).most_common(1)[0]
    if count / len(rows) >= _DOMINANT_SHARE:
        return album, top
    return album, VARIOUS


def _key(path: str) -> str:
    """Path in the one form the row map is keyed by (Windows is case-blind)."""
    return os.path.normcase(os.path.normpath(path))


async def _row_map(session: AsyncSession) -> dict[str, Download]:
    """Every download that still points at a file, keyed by that path.

    Read once per run rather than per folder — the table is small and a repair
    walks thousands of files.
    """
    result = await session.execute(
        select(Download).where(Download.output_path.is_not(None)).order_by(Download.id)
    )
    # Later rows win: a re-download is the more recent truth about a path.
    return {_key(row.output_path): row for row in result.scalars()}


def plan_folder(
    folder: str,
    rows: dict[str, Download],
    *,
    overwrite_cover: bool = False,
) -> FolderPlan:
    """What repairing *folder* would change, without changing anything.

    *rows* is the whole-run row map from :func:`_row_map`.
    """
    paths = _audio_files(folder)
    plan = FolderPlan(folder=folder)
    if not paths:
        return plan

    # Pass one: per-file tags, exactly as the download path would derive them.
    staged: list[tuple[str, dict, dict]] = []
    for path in paths:
        info = _info_from_row(rows.get(_key(path)), path)
        staged.append((path, derive_tags(path, info), read_tags(path)))

    # Pass two: the folder decides album and album artist for all of them.
    plan.album, plan.album_artist = _reconcile(folder, staged)

    for path, tags, current in staged:
        tags = dict(tags)
        tags["album"] = plan.album
        tags["album_artist"] = plan.album_artist
        row = rows.get(_key(path))
        plan.files.append(
            FilePlan(path=path, tags=tags, current=current,
                     embed_art=bool(row and row.thumbnail))
        )

    cover = os.path.join(folder, "cover.jpg")
    has_thumb = any(
        rows[k].thumbnail for k in map(_key, paths) if k in rows and rows[k].thumbnail
    )
    if has_thumb and (overwrite_cover or not os.path.exists(cover)):
        plan.cover, plan.write_cover = cover, True

    return plan


def apply_folder(plan: FolderPlan, *, thumbnails: dict[str, str]) -> None:
    """Write *plan* to disk. Best-effort per file — one failure is recorded on
    that file and the rest of the folder still gets repaired."""
    for item in plan.files:
        if not item.would_change:
            continue
        cover, mime = None, "image/jpeg"
        url = thumbnails.get(item.path)
        if item.embed_art and url:
            try:
                fetched = artwork.fetch_cover_bytes(url)
                if fetched:
                    cover, mime = fetched
            except Exception as exc:  # noqa: BLE001 — art must not cost the tags
                logger.warning("cover fetch failed for %s: %s", item.path, exc)
        try:
            write_tags(item.path, item.tags, cover, mime)
        except TaggingError as exc:
            item.error = str(exc)
            logger.warning("retag failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            item.error = f"{type(exc).__name__}: {exc}"
            logger.warning("retag failed for %s: %s", item.path, exc)

    if plan.write_cover:
        url = next((thumbnails[f.path] for f in plan.files if f.path in thumbnails), None)
        try:
            artwork.write_music_cover(plan.folder, url, overwrite=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("cover write failed for %s: %s", plan.folder, exc)


async def repair_music(
    session: AsyncSession,
    root: str,
    *,
    apply: bool = False,
    overwrite_cover: bool = False,
) -> dict:
    """Repair every audio folder under *root*.

    With ``apply=False`` (the default) nothing is written and the report says
    what would change. The caller is responsible for *root* being a real,
    allowed folder — see ``storage.get_root`` / ``resolve_in_root``.
    """
    folders = _folders(root)
    report: dict = {
        "root": root,
        "applied": apply,
        "folders": [],
        "folders_scanned": len(folders),
        "files_scanned": 0,
        "files_changed": 0,
        "covers_written": 0,
        "errors": [],
    }

    rows = await _row_map(session)

    for folder in folders:
        plan = plan_folder(folder, rows, overwrite_cover=overwrite_cover)
        if not plan.files:
            continue

        thumbnails = {
            f.path: rows[_key(f.path)].thumbnail
            for f in plan.files
            if _key(f.path) in rows and rows[_key(f.path)].thumbnail
        }

        if apply:
            apply_folder(plan, thumbnails=thumbnails)

        changed = plan.changed_files
        report["files_scanned"] += len(plan.files)
        report["files_changed"] += len([f for f in changed if not f.error])
        if plan.write_cover:
            report["covers_written"] += 1
        for item in plan.files:
            if item.error:
                report["errors"].append({"path": item.path, "error": item.error})

        if changed or plan.write_cover:
            report["folders"].append({
                "folder": folder,
                "album": plan.album,
                "album_artist": plan.album_artist,
                "cover": plan.cover,
                "files": [
                    {
                        "path": f.path,
                        "name": os.path.basename(f.path),
                        "changes": f.changes,
                        "embed_art": f.embed_art,
                        "error": f.error,
                    }
                    for f in changed
                ],
            })

    return report
