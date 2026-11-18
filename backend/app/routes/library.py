"""Library actions on completed downloads: bulk move/delete, rescan, import.

Moves go through services.storage, so the library rows follow the files. Every
path stays inside DOWNLOAD_DIR, the same boundary as the file manager.
"""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Download
from app.services.storage import (
    is_inside,
    move_entry,
    resolve_inside,
    root_dir,
    to_rel,
    valid_name,
)
from app.utils import MEDIA_EXTS, _normalize_stem, is_audio_path

router = APIRouter(prefix="/api/library", tags=["library"])


class BulkMoveRequest(BaseModel):
    ids: list[int]
    folder: str = ""


class BulkDeleteRequest(BaseModel):
    ids: list[int]
    delete_files: bool = False


class ImportRequest(BaseModel):
    paths: list[str]


def _owned_file(download: Download) -> str | None:
    """The row's file, if it exists and sits inside the download root."""
    path = download.output_path
    if not path or not os.path.isfile(path):
        return None
    return path if is_inside(path, root_dir()) else None


@router.post("/move")
async def bulk_move(req: BulkMoveRequest, session: AsyncSession = Depends(get_session)) -> dict:
    dest = resolve_inside(req.folder)
    if not os.path.isdir(dest):
        raise HTTPException(status_code=404, detail="Destination folder not found")

    results = []
    for dl_id in req.ids:
        download = await session.get(Download, dl_id)
        result = {"id": dl_id, "ok": False, "error": None, "new_path": None}
        results.append(result)
        if download is None:
            result["error"] = "Not in library"
            continue
        src = _owned_file(download)
        if src is None:
            result["error"] = "File not found in the download folder"
            continue
        target = os.path.join(dest, os.path.basename(src))
        if os.path.lexists(target):
            result["error"] = "A file with that name already exists there"
            continue
        try:
            await move_entry(session, src, target)
        except OSError as exc:
            result["error"] = str(exc)
            continue
        download = await session.get(Download, dl_id)
        download.output_dir = dest
        await session.commit()
        result.update(ok=True, new_path=to_rel(target))
    return {"results": results}


@router.post("/delete")
async def bulk_delete(req: BulkDeleteRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Remove rows from the library; optionally delete their files too."""
    results = []
    for dl_id in req.ids:
        download = await session.get(Download, dl_id)
        result = {"id": dl_id, "ok": False, "error": None}
        results.append(result)
        if download is None:
            result["error"] = "Not in library"
            continue
        if req.delete_files:
            path = _owned_file(download)
            if path is not None:
                try:
                    os.remove(path)
                except OSError as exc:
                    result["error"] = str(exc)
                    continue
        await session.delete(download)
        result["ok"] = True
    await session.commit()
    return {"results": results}


def _media_files(root: str) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in MEDIA_EXTS:
                found.append(os.path.join(dirpath, name))
    return found


# ── Matching files on disk back to the subscription that owns them ───────────
#
# A download started by a subscription carries its subscription_id, and the
# Dashboard groups by that column. Files found on disk — imported by hand or
# picked up by a rescan — have no such link, so episodes sitting in the very
# same folder as the rest of a show were listed under "Other Completed
# Downloads" instead of with the show. The folder is the thing both have in
# common, so that is what we match on.


async def _subscription_dirs(session: AsyncSession) -> list[tuple[str, int | None]]:
    """``(folder, subscription id)`` for every subscription, deepest folder first.

    A folder claimed by two subscriptions maps to ``None``: there is no right
    answer, and guessing one would file episodes under the wrong show.
    """
    from app.models import Subscription
    from app.utils import subscription_download_dir

    subs = (await session.execute(select(Subscription))).scalars().all()
    by_dir: dict[str, list[int]] = {}
    for sub in subs:
        folder = subscription_download_dir(sub, root_dir())
        if folder:
            by_dir.setdefault(os.path.realpath(folder), []).append(sub.id)

    dirs = [(d, ids[0] if len(ids) == 1 else None) for d, ids in by_dir.items()]
    # Deepest first, so a subscription nested inside another's folder wins.
    dirs.sort(key=lambda pair: len(pair[0]), reverse=True)
    return dirs


def _subscription_for(path: str, dirs: list[tuple[str, int | None]]) -> int | None:
    """The subscription whose folder holds *path*, or None."""
    folder = os.path.realpath(os.path.dirname(path))
    for subscription_dir, sub_id in dirs:
        if folder == subscription_dir or folder.startswith(subscription_dir + os.sep):
            return sub_id
    return None


@router.post("/rescan")
async def rescan(session: AsyncSession = Depends(get_session)) -> dict:
    """Find library rows whose file moved, relink them, and list media files
    in the download folder that no row points at yet."""
    root = root_dir()
    files = _media_files(root) if os.path.isdir(root) else []
    rows = (await session.execute(select(Download).where(Download.output_path.is_not(None)))).scalars().all()

    linked = {os.path.realpath(d.output_path) for d in rows if d.output_path and os.path.isfile(d.output_path)}
    by_stem: dict[str, list[str]] = {}
    for path in files:
        by_stem.setdefault(_normalize_stem(os.path.basename(path)), []).append(path)

    relinked, missing = [], []
    claimed: set[str] = set()
    for d in rows:
        if d.output_path and os.path.isfile(d.output_path):
            continue
        candidates = [
            p for p in by_stem.get(_normalize_stem(d.title or ""), [])
            if os.path.realpath(p) not in linked and os.path.realpath(p) not in claimed
        ] if d.title else []
        if len(candidates) == 1:
            new = candidates[0]
            claimed.add(os.path.realpath(new))
            relinked.append({"id": d.id, "title": d.title, "path": to_rel(new)})
            d.output_path = new
            d.output_dir = os.path.dirname(new)
        else:
            missing.append({"id": d.id, "title": d.title})
    await session.commit()

    # Rows that sit in a subscription's folder but were never linked to it —
    # imported by hand, or created before this matching existed. Without this
    # they stay in "Other Completed Downloads" forever, next to the very
    # episodes they belong with.
    dirs = await _subscription_dirs(session)
    attributed = []
    if dirs:
        orphans = (
            await session.execute(
                select(Download).where(
                    Download.subscription_id.is_(None),
                    Download.output_path.is_not(None),
                )
            )
        ).scalars().all()
        for d in orphans:
            if not d.output_path or not os.path.isfile(d.output_path):
                continue
            sub_id = _subscription_for(d.output_path, dirs)
            if sub_id is not None:
                d.subscription_id = sub_id
                attributed.append({"id": d.id, "title": d.title, "subscription_id": sub_id})
        if attributed:
            await session.commit()

    now_linked = linked | {os.path.realpath(r) for r in claimed}
    unlinked = [to_rel(p) for p in files if os.path.realpath(p) not in now_linked]
    return {
        "relinked": relinked,
        "missing": missing,
        "attributed": attributed,
        "unlinked": sorted(unlinked, key=str.lower)[:1000],
    }


@router.post("/import")
async def import_files(req: ImportRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Add files already in the download folder to the library as completed rows."""
    created = []
    dirs = await _subscription_dirs(session)
    for rel in req.paths:
        path = resolve_inside(rel)
        if not os.path.isfile(path):
            continue
        stem = os.path.splitext(os.path.basename(path))[0]
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        audio = is_audio_path(path)
        row = Download(
            url=f"file://{path}",
            title=stem,
            status="completed",
            percent=100.0,
            format_spec="best",
            ext=ext or None,
            vcodec="none" if audio else None,
            output_dir=os.path.dirname(path),
            output_path=path,
            filesize=os.path.getsize(path),
            # Files dropped into a subscription's folder belong to that show,
            # however they got there.
            subscription_id=_subscription_for(path, dirs),
        )
        session.add(row)
        await session.flush()
        created.append({"id": row.id, "title": stem})
    await session.commit()
    return {"created": created}
