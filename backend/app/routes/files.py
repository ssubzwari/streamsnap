"""File manager: browse, create folders, move/copy, rename, delete under DOWNLOAD_DIR.

Every path comes in root-relative and goes through ``services.storage``, which
refuses anything that resolves outside the download root. Moves and renames
keep the library (downloads and subscriptions) pointing at the new location.
"""

import mimetypes
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.services.storage import (
    active_download_under,
    copy_entry,
    delete_entry,
    is_inside,
    move_entry,
    resolve_inside,
    root_dir,
    to_rel,
    valid_name,
)

router = APIRouter(prefix="/api/files", tags=["files"])


class FolderCreate(BaseModel):
    path: str = ""
    name: str


class TransferRequest(BaseModel):
    items: list[str]
    dest: str = ""
    mode: str = "move"  # move | copy


class RenameRequest(BaseModel):
    path: str
    name: str


class DeleteRequest(BaseModel):
    items: list[str]


def _entry(scan_entry: os.DirEntry) -> dict:
    stat = scan_entry.stat()
    is_dir = scan_entry.is_dir()
    return {
        "name": scan_entry.name,
        "path": to_rel(scan_entry.path),
        "is_dir": is_dir,
        "size": None if is_dir else stat.st_size,
        "modified": stat.st_mtime,
        "ext": "" if is_dir else os.path.splitext(scan_entry.name)[1].lower(),
    }


@router.get("")
async def list_folder(path: str = "", dirs_only: bool = False) -> dict:
    folder = resolve_inside(path)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Folder not found")

    entries = []
    for scan_entry in os.scandir(folder):
        try:
            item = _entry(scan_entry)
        except OSError:
            continue
        if dirs_only and not item["is_dir"]:
            continue
        entries.append(item)
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    current = to_rel(folder)
    return {
        "path": current,
        "parent": None if not current else to_rel(os.path.dirname(folder)),
        "root": root_dir(),
        "entries": entries,
    }


@router.post("/folders", status_code=201)
async def create_folder(req: FolderCreate) -> dict:
    parent = resolve_inside(req.path)
    if not os.path.isdir(parent):
        raise HTTPException(status_code=404, detail="Parent folder not found")
    target = os.path.join(parent, valid_name(req.name))
    if os.path.lexists(target):
        raise HTTPException(status_code=409, detail="A file or folder with that name already exists")
    os.makedirs(target)
    return {"path": to_rel(target)}


@router.get("/raw")
async def raw_file(path: str, download: bool = False) -> FileResponse:
    target = resolve_inside(path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="File not found")
    media_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
    if download:
        return FileResponse(target, media_type=media_type, filename=os.path.basename(target), content_disposition_type="attachment")
    return FileResponse(target, media_type=media_type, content_disposition_type="inline")


@router.post("/transfer")
async def transfer(req: TransferRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Move or copy items into a folder. Name clashes are skipped, not overwritten."""
    if req.mode not in ("move", "copy"):
        raise HTTPException(status_code=400, detail="mode must be 'move' or 'copy'")
    dest_dir = resolve_inside(req.dest)
    if not os.path.isdir(dest_dir):
        raise HTTPException(status_code=404, detail="Destination folder not found")

    results = []
    for item in req.items:
        result = {"path": item, "ok": False, "error": None, "new_path": None}
        results.append(result)
        try:
            src = resolve_inside(item)
            if src == root_dir() or not os.path.lexists(src):
                raise HTTPException(status_code=400, detail="Item not found or is the download root")
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
            result.update(ok=True, new_path=to_rel(target))
        except HTTPException as exc:
            result["error"] = exc.detail
        except OSError as exc:
            result["error"] = str(exc)
    return {"results": results}


@router.post("/rename")
async def rename(req: RenameRequest, session: AsyncSession = Depends(get_session)) -> dict:
    src = resolve_inside(req.path)
    if src == root_dir() or not os.path.lexists(src):
        raise HTTPException(status_code=400, detail="Item not found or is the download root")
    target = os.path.join(os.path.dirname(src), valid_name(req.name))
    if target == src:
        return {"path": to_rel(src)}
    if os.path.lexists(target):
        raise HTTPException(status_code=409, detail="A file or folder with that name already exists")
    if await active_download_under(session, src):
        raise HTTPException(status_code=409, detail="Downloads are running in this folder")
    await move_entry(session, src, target)
    return {"path": to_rel(target)}


@router.post("/delete")
async def delete(req: DeleteRequest, session: AsyncSession = Depends(get_session)) -> dict:
    """Permanently delete files or folders from disk (the library rows follow)."""
    results = []
    for item in req.items:
        result = {"path": item, "ok": False, "error": None}
        results.append(result)
        try:
            target = resolve_inside(item)
            if target == root_dir() or not os.path.lexists(target):
                raise HTTPException(status_code=400, detail="Item not found or is the download root")
            if await active_download_under(session, target):
                raise HTTPException(status_code=409, detail="Downloads are running in this folder")
            await delete_entry(session, target)
            result["ok"] = True
        except HTTPException as exc:
            result["error"] = exc.detail
        except OSError as exc:
            result["error"] = str(exc)
    return {"results": results}
