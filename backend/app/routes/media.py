"""Media Manager: browse and manage files under Downloads and extra media roots.

Roots are addressed by id ('0' = DOWNLOAD_DIR, '1'.. = ``media_folders``).
Every path is root-relative and confined to its root by ``services.storage``.
"""

import asyncio
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Download
from app.services.storage import (
    active_download_under,
    copy_entry,
    delete_keep_rows,
    get_root,
    is_inside,
    media_kind,
    media_roots,
    move_entry,
    rel_in_root,
    resolve_in_root,
    valid_name,
)

router = APIRouter(prefix="/api/media", tags=["media"])

COUNT_CAP = 20000


class FolderCreate(BaseModel):
    root: str = "0"
    path: str = ""
    name: str


class RenameRequest(BaseModel):
    root: str = "0"
    path: str
    new_name: str


class TransferRequest(BaseModel):
    root: str = "0"
    items: list[str]
    dest_root: str | None = None
    dest: str = ""
    mode: str = "move"  # move | copy


class DeleteRequest(BaseModel):
    root: str = "0"
    items: list[str]


def _count_files(root: str) -> int:
    count = 0
    for _dir, _dirs, files in os.walk(root):
        count += len(files)
        if count >= COUNT_CAP:
            return COUNT_CAP
    return count


def _existing_item(root: str, rel: str) -> str:
    """Absolute path of an existing item inside *root*; the root itself is not an item."""
    target = resolve_in_root(root, rel)
    if target == os.path.normpath(root) or not os.path.lexists(target):
        raise HTTPException(status_code=400, detail="Item not found or is the root")
    return target


@router.get("/roots")
async def list_roots(session: AsyncSession = Depends(get_session)) -> dict:
    roots = []
    for root in await media_roots(session):
        available = os.path.isdir(root["path"])
        count = await asyncio.to_thread(_count_files, root["path"]) if available else 0
        roots.append({**root, "available": available, "file_count": count})
    return {"roots": roots}


@router.get("/list")
async def list_folder(root: str = "0", path: str = "", session: AsyncSession = Depends(get_session)) -> dict:
    base = await get_root(session, root)
    folder = resolve_in_root(base, path)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Folder not found")

    rows = (await session.execute(
        select(Download.id, Download.output_path)
        .where(Download.output_path.is_not(None)).order_by(Download.id)
    )).all()
    by_path = {os.path.abspath(p): i for i, p in rows}

    entries = []
    with os.scandir(folder) as it:
        for scan in it:
            if scan.name.startswith("."):
                continue
            try:
                if not is_inside(scan.path, base):
                    continue
                stat = scan.stat()
                is_dir = scan.is_dir()
            except OSError:
                continue
            entries.append({
                "name": scan.name,
                "path": rel_in_root(base, scan.path),
                "is_dir": is_dir,
                "size": None if is_dir else stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "kind": media_kind(scan.name, is_dir),
                "download_id": None if is_dir else by_path.get(os.path.abspath(scan.path)),
            })
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    current = rel_in_root(base, folder)
    return {
        "root": root,
        "path": current,
        "parent": None if not current else rel_in_root(base, os.path.dirname(folder)),
        "entries": entries,
    }


@router.post("/folders", status_code=201)
async def create_folder(req: FolderCreate, session: AsyncSession = Depends(get_session)) -> dict:
    base = await get_root(session, req.root)
    parent = resolve_in_root(base, req.path)
    if not os.path.isdir(parent):
        raise HTTPException(status_code=404, detail="Parent folder not found")
    target = os.path.join(parent, valid_name(req.name))
    if os.path.lexists(target):
        raise HTTPException(status_code=409, detail="A file or folder with that name already exists")
    os.makedirs(target)
    return {"root": req.root, "path": rel_in_root(base, target)}


@router.post("/rename")
async def rename(req: RenameRequest, session: AsyncSession = Depends(get_session)) -> dict:
    base = await get_root(session, req.root)
    src = _existing_item(base, req.path)
    target = os.path.join(os.path.dirname(src), valid_name(req.new_name))
    if target == src:
        return {"root": req.root, "path": rel_in_root(base, src)}
    if os.path.lexists(target):
        raise HTTPException(status_code=409, detail="A file or folder with that name already exists")
    if await active_download_under(session, src):
        raise HTTPException(status_code=409, detail="Downloads are running in this folder")
    try:
        await move_entry(session, src, target)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"root": req.root, "path": rel_in_root(base, target)}


@router.post("/transfer")
async def transfer(req: TransferRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Move or copy items into a folder, possibly in another root. Clashes are skipped."""
    if req.mode not in ("move", "copy"):
        raise HTTPException(status_code=400, detail="mode must be 'move' or 'copy'")
    dest_root_id = req.root if req.dest_root is None else req.dest_root
    base = await get_root(session, req.root)
    dest_base = await get_root(session, dest_root_id)
    dest_dir = resolve_in_root(dest_base, req.dest)
    if not os.path.isdir(dest_dir):
        raise HTTPException(status_code=404, detail="Destination folder not found")

    results = []
    for item in req.items:
        result = {"path": item, "ok": False, "error": None, "new_path": None}
        results.append(result)
        try:
            src = _existing_item(base, item)
            if is_inside(dest_dir, src) and os.path.isdir(src):
                raise HTTPException(status_code=400, detail="Can't put a folder inside itself")
            target = os.path.join(dest_dir, os.path.basename(src))
            if os.path.lexists(target):
                raise HTTPException(status_code=409, detail="Already exists in destination")
            if req.mode == "move":
                if await active_download_under(session, src):
                    raise HTTPException(status_code=409, detail="Downloads are running in this folder")
                await move_entry(session, src, target)
            else:
                await copy_entry(src, target)
            result.update(ok=True, new_path=rel_in_root(dest_base, target))
        except HTTPException as exc:
            result["error"] = exc.detail
        except OSError as exc:
            result["error"] = str(exc)
    return {"dest_root": dest_root_id, "results": results}


@router.post("/delete")
async def delete(req: DeleteRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Permanently delete files or folders. Download rows stay; their output_path is cleared."""
    base = await get_root(session, req.root)
    results = []
    for item in req.items:
        result = {"path": item, "ok": False, "error": None}
        results.append(result)
        try:
            target = _existing_item(base, item)
            if await active_download_under(session, target):
                raise HTTPException(status_code=409, detail="Downloads are running in this folder")
            await delete_keep_rows(session, target)
            result["ok"] = True
        except HTTPException as exc:
            result["error"] = exc.detail
        except OSError as exc:
            result["error"] = str(exc)
    return {"results": results}
