"""Where files may live.

Every folder the app saves into, lists, moves, copies or deletes comes through
this module, so the boundary is enforced in one place. The boundary is
``DOWNLOAD_DIR`` (the admin's bind mount). The user-facing default folder
(Settings → Download Folder) is a folder inside it, stored root-relative.
"""

import json
import os
import shutil

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Download, Setting, Subscription

DEFAULT_FOLDER_KEY = "download_folder"
_ROOT_ALIASES = {".", "Default"}


def root_dir() -> str:
    return os.path.abspath(settings.DOWNLOAD_DIR)


def is_inside(path: str, base: str) -> bool:
    """True when *path* is *base* or lives under it, following symlinks."""
    real_path = os.path.realpath(path)
    real_base = os.path.realpath(base)
    return real_path == real_base or real_path.startswith(real_base.rstrip(os.sep) + os.sep)


def normalize_rel(rel: str | None) -> str:
    """Root-relative form of a user-supplied folder. Empty means the root."""
    raw = (rel or "").strip()
    # "./downloads" is the old Settings default, which older installs saved.
    # It always meant the root, so keep meaning that.
    if raw == "./downloads":
        return ""
    value = os.path.normpath(raw.replace("\\", "/").strip("/") or ".")
    return "" if value in _ROOT_ALIASES else value.replace(os.sep, "/")


def resolve_inside(rel: str | None) -> str:
    """Absolute path for a root-relative folder. 400 if it would leave the root."""
    root = root_dir()
    target = os.path.normpath(os.path.join(root, normalize_rel(rel)))
    if not is_inside(target, root):
        raise HTTPException(status_code=400, detail="Path must be inside the download folder")
    return target


def to_rel(path: str) -> str:
    rel = os.path.relpath(os.path.abspath(path), root_dir())
    return "" if rel == "." else rel.replace(os.sep, "/")


def valid_name(name: str) -> str:
    """A single path component. Rejects separators and dot names."""
    cleaned = (name or "").strip()
    if not cleaned or cleaned in (".", "..") or "/" in cleaned or "\\" in cleaned or "\x00" in cleaned:
        raise HTTPException(status_code=400, detail=f"Invalid name: {name!r}")
    return cleaned


async def default_download_dir(session: AsyncSession) -> str:
    """The folder new downloads land in when the user picks nothing.

    Falls back to the root if the saved folder has gone missing.
    """
    row = await session.get(Setting, DEFAULT_FOLDER_KEY)
    root = root_dir()
    os.makedirs(root, exist_ok=True)
    try:
        folder = resolve_inside(row.value if row else "")
    except HTTPException:
        return root
    return folder if os.path.isdir(folder) else root


async def destination_base(session: AsyncSession, folder_rel: str | None, category_rel: str = "") -> str:
    """Resolve the folder a new download/subscription writes into.

    An explicit folder is used exactly as chosen. Otherwise the default folder,
    with the category/subcategory/tag path (if any) appended.
    """
    if folder_rel is not None and normalize_rel(folder_rel):
        base = resolve_inside(folder_rel)
    else:
        base = await default_download_dir(session)
        if category_rel:
            base = os.path.join(base, category_rel)
    os.makedirs(base, exist_ok=True)
    return base


def _under(path: str | None, base: str) -> bool:
    return bool(path) and is_inside(os.path.abspath(path), base)


def _rebase(path: str, src: str, dst: str) -> str:
    rel = os.path.relpath(os.path.abspath(path), src)
    return dst if rel == "." else os.path.join(dst, rel)


async def active_download_under(session: AsyncSession, path: str) -> bool:
    """Any queued or running download that writes into *path*?"""
    rows = (
        await session.execute(
            select(Download).where(Download.status.in_(("queued", "downloading")))
        )
    ).scalars()
    return any(_under(d.output_dir, path) or _under(d.output_path, path) for d in rows)


async def _repoint(session: AsyncSession, src: str, dst: str) -> None:
    rows = (
        await session.execute(
            select(Download).where(or_(Download.output_path.is_not(None), Download.output_dir.is_not(None)))
        )
    ).scalars()
    for d in rows:
        for attr in ("output_path", "output_dir"):
            value = getattr(d, attr)
            if _under(value, src):
                setattr(d, attr, _rebase(value, src, dst))

    subs = (
        await session.execute(select(Subscription).where(Subscription.download_dir.is_not(None)))
    ).scalars()
    for s in subs:
        if _under(s.download_dir, src):
            s.download_dir = _rebase(s.download_dir, src, dst)


async def move_entry(session: AsyncSession, src: str, dst: str) -> None:
    """Move a file or folder and repoint the DB rows under it.

    The caller has already checked guards (inside root, no conflict, nothing
    running). If the DB commit fails the disk move is reversed, so the library
    never points at paths that no longer exist.
    """
    shutil.move(src, dst)
    try:
        await _repoint(session, src, dst)
        await session.commit()
    except Exception:
        await session.rollback()
        shutil.move(dst, src)
        raise


async def copy_entry(src: str, dst: str) -> None:
    """Copy a file or folder. Copies are not library entries, so no DB change."""
    if os.path.isdir(src):
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


async def delete_entry(session: AsyncSession, path: str) -> None:
    """Remove a file or folder from disk and the library rows that pointed at it."""
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)
    rows = (
        await session.execute(
            select(Download).where(Download.output_path.is_not(None))
        )
    ).scalars()
    for d in rows:
        if _under(d.output_path, path):
            await session.delete(d)
    await session.commit()


def set_default_folder_value(rel: str | None) -> str:
    """Validated, normalized value to store for the default-folder setting.
    Creates the folder if it doesn't exist yet."""
    normalized = normalize_rel(rel)
    os.makedirs(resolve_inside(normalized), exist_ok=True)
    return normalized



# ── Media roots (Downloads + admin-listed extra folders) ─────────────────────

MEDIA_FOLDERS_KEY = "media_folders"
# Mirrors AUDIO_EXT / VIDEO_EXT in frontend/src/player/PlayerContext.tsx.
AUDIO_EXTENSIONS = frozenset({"m4a", "m4b", "mp3", "opus", "ogg", "oga", "aac", "flac", "wav", "weba", "mka"})
VIDEO_EXTENSIONS = frozenset({"mp4", "m4v", "webm", "mkv", "mov", "avi", "ts"})


def media_kind(name: str, is_dir: bool) -> str:
    if is_dir:
        return "folder"
    ext = os.path.splitext(name)[1].lstrip(".").lower()
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "other"


def validate_media_folders(raw: str | None) -> str:
    """Validated JSON list to store for ``media_folders``. 400 on any bad entry."""
    if raw is None or not raw.strip():
        return "[]"
    try:
        paths = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="media_folders must be a JSON list of paths")
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise HTTPException(status_code=400, detail="media_folders must be a JSON list of paths")
    clean: list[str] = []
    seen: set[str] = set()
    for item in paths:
        path = item.strip()
        if not os.path.isabs(path):
            raise HTTPException(status_code=400, detail=f"Media folder must be an absolute path: {item!r}")
        path = os.path.normpath(path)
        if not os.path.isdir(path):
            raise HTTPException(status_code=400, detail=f"Media folder does not exist or is not a directory: {path}")
        if is_inside(path, root_dir()):
            raise HTTPException(status_code=400, detail=f"Media folder is the download folder or inside it: {path}")
        real = os.path.realpath(path)
        if real in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate media folder: {path}")
        seen.add(real)
        clean.append(path)
    return json.dumps(clean)


async def media_roots(session: AsyncSession) -> list[dict]:
    """Ordered roots: id '0' is DOWNLOAD_DIR, '1'.. are the saved media folders."""
    roots = [{"id": "0", "label": "Downloads", "path": root_dir()}]
    row = await session.get(Setting, MEDIA_FOLDERS_KEY)
    try:
        extra = json.loads(row.value) if row and row.value else []
    except ValueError:
        extra = []
    for i, path in enumerate(p for p in extra if isinstance(p, str)):
        roots.append({"id": str(i + 1), "label": os.path.basename(path.rstrip("/")) or path, "path": path})
    return roots


async def get_root(session: AsyncSession, root_id: str) -> str:
    """Absolute path of a root. 404 unknown id, 409 when the folder is not mounted."""
    for root in await media_roots(session):
        if root["id"] == str(root_id):
            if not os.path.isdir(root["path"]):
                raise HTTPException(status_code=409, detail=f"Root '{root['label']}' is unavailable (folder not found: {root['path']})")
            return root["path"]
    raise HTTPException(status_code=404, detail="Unknown root")


def resolve_in_root(root: str, rel: str | None) -> str:
    """Absolute path for a root-relative path. 400 if it would leave *root* (symlinks included)."""
    target = os.path.normpath(os.path.join(root, normalize_rel(rel)))
    if not is_inside(target, root):
        raise HTTPException(status_code=400, detail="Path must be inside the root")
    return target


def rel_in_root(root: str, path: str) -> str:
    rel = os.path.relpath(os.path.abspath(path), root)
    return "" if rel == "." else rel.replace(os.sep, "/")


async def delete_keep_rows(session: AsyncSession, path: str) -> None:
    """Delete from disk permanently. Download rows stay (history); their output_path is cleared."""
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)
    rows = (await session.execute(select(Download).where(Download.output_path.is_not(None)))).scalars()
    for d in rows:
        if _under(d.output_path, path) and not os.path.lexists(d.output_path):
            d.output_path = None
    await session.commit()
