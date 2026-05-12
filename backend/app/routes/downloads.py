import asyncio
import mimetypes
import pathlib

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Download, Subscription
from app.schemas import DownloadCreateRequest, DownloadInfo
from app.services.download_manager import download_manager
from app.services.notifications import create_notification
from app.utils import category_subdir, find_existing_file, safe_folder_name
from app.ws import emit_download_added, emit_download_completed

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


@router.post("", response_model=DownloadInfo, status_code=201)
async def create_download(
    req: DownloadCreateRequest,
    session: AsyncSession = Depends(get_session),
) -> DownloadInfo:
    # Check if this URL is already subscribed to. If so, link to that subscription.
    sub_row = await session.execute(
        select(Subscription).where(Subscription.url == req.url)
    )
    subscription = sub_row.scalars().first()

    # Resolve the destination folder. If subscribed, use subscription's settings;
    # otherwise use provided category/subcategory/tag.
    rel = None  # Track whether we're using a categorized path (for enqueue)
    if subscription:
        # Use subscription's folder and format (unless explicitly overridden)
        if subscription.download_dir:
            download_dir = subscription.download_dir
        else:
            # Subscription doesn't have a custom dir, use its category structure
            rel = category_subdir(subscription.category, subscription.subcategory, subscription.tag)
            if rel:
                download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / rel)
                pathlib.Path(download_dir).mkdir(parents=True, exist_ok=True)
            else:
                download_dir = settings.DOWNLOAD_DIR

        # Use subscription's format if not overridden in request
        format_spec = req.format_spec or subscription.format_spec or "bestvideo*+bestaudio/best"
        category = subscription.category
        subcategory = subscription.subcategory
        tag = subscription.tag
    else:
        # Manual download without subscription
        rel = category_subdir(req.category, req.subcategory, req.tag)
        if rel:
            download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / rel)
            pathlib.Path(download_dir).mkdir(parents=True, exist_ok=True)
        else:
            download_dir = settings.DOWNLOAD_DIR
        format_spec = req.format_spec
        category = req.category
        subcategory = req.subcategory
        tag = req.tag

    # Probe the resolved folder *before* enqueuing. If a file with the same
    # title is already on disk (from a previous run, a manual copy, or a DB
    # wipe that left the files behind), record a completed row pointing at
    # the existing file instead of re-downloading.
    existing_path = find_existing_file(download_dir, req.title)

    download = Download(
        url=req.url,
        title=req.title,
        thumbnail=req.thumbnail,
        duration=req.duration,
        format_spec=format_spec,
        status="completed" if existing_path else "queued",
        percent=100.0 if existing_path else 0.0,
        output_path=existing_path,
        subscription_id=subscription.id if subscription else None,
        category=category,
        subcategory=subcategory,
        tag=tag,
    )
    session.add(download)
    await session.commit()
    await session.refresh(download)

    info = DownloadInfo.model_validate(download)
    await emit_download_added(info.model_dump(mode="json"))

    if existing_path:
        payload = info.model_dump(mode="json")
        await emit_download_completed(payload)
        await create_notification(
            kind="completed",
            title="File already exists — skipping download",
            body=f"{req.title or req.url}\n{existing_path}",
            thumbnail=req.thumbnail,
            payload={"download_id": download.id, "path": existing_path, "skipped": True},
        )
        return info

    await download_manager.enqueue(
        download.id, req.url, format_spec, download_dir if rel else None
    )
    return info


class PlaylistDownloadRequest(BaseModel):
    url: str
    format_spec: str = "bestvideo*+bestaudio/best"
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None


@router.post("/playlist", response_model=list[DownloadInfo], status_code=201)
async def download_playlist(
    req: PlaylistDownloadRequest,
    session: AsyncSession = Depends(get_session),
) -> list[DownloadInfo]:
    """Extract all videos from a playlist, create a folder, and enqueue downloads.

    If the playlist URL is already subscribed, link all downloads to that subscription
    to prevent duplicates and keep them grouped together.
    """
    from app.ytdl.service import extract_playlist

    try:
        playlist_data = await asyncio.to_thread(extract_playlist, req.url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Check if this playlist URL is already subscribed to
    sub_row = await session.execute(
        select(Subscription).where(Subscription.url == req.url)
    )
    subscription = sub_row.scalars().first()

    # Dedupe by video id so a playlist that lists the same video twice
    # doesn't enqueue two downloads writing to the same output path.
    _seen: set[str] = set()
    deduped: list[dict] = []
    for entry in playlist_data["entries"]:
        vid = entry.get("id")
        if not vid or vid in _seen:
            continue
        _seen.add(vid)
        deduped.append(entry)
    playlist_data["entries"] = deduped

    # Determine destination folder and metadata
    if subscription:
        # Use subscription's folder and settings
        if subscription.download_dir:
            download_dir = subscription.download_dir
        else:
            # Subscription doesn't have a custom dir; use its category structure
            rel = category_subdir(subscription.category, subscription.subcategory, subscription.tag)
            if rel:
                folder_name = safe_folder_name(playlist_data["title"])
                download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / rel / folder_name)
            else:
                download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / safe_folder_name(playlist_data["title"]))
        format_spec = req.format_spec or subscription.format_spec or "bestvideo*+bestaudio/best"
        category = subscription.category
        subcategory = subscription.subcategory
        tag = subscription.tag
    else:
        # Manual playlist download without subscription
        folder_name = safe_folder_name(playlist_data["title"])
        rel = category_subdir(req.category, req.subcategory, req.tag)
        if rel:
            download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / rel / folder_name)
        else:
            download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / folder_name)
        format_spec = req.format_spec
        category = req.category
        subcategory = req.subcategory
        tag = req.tag

    pathlib.Path(download_dir).mkdir(parents=True, exist_ok=True)

    results: list[DownloadInfo] = []
    skipped_titles: list[str] = []
    for entry in playlist_data["entries"]:
        title = entry.get("title")
        # Scan the *playlist folder* specifically, so the same video name
        # existing at the top level of DOWNLOAD_DIR doesn't mask a genuine
        # miss inside this playlist.
        existing_path = find_existing_file(download_dir, title)

        dl = Download(
            url=entry["url"],
            title=title,
            format_spec=format_spec,
            status="completed" if existing_path else "queued",
            percent=100.0 if existing_path else 0.0,
            output_path=existing_path,
            subscription_id=subscription.id if subscription else None,
            category=category,
            subcategory=subcategory,
            tag=tag,
        )
        session.add(dl)
        await session.flush()

        info = DownloadInfo.model_validate(dl)
        await emit_download_added(info.model_dump(mode="json"))

        if existing_path:
            await emit_download_completed(info.model_dump(mode="json"))
            skipped_titles.append(title or entry["url"])
        else:
            await download_manager.enqueue(dl.id, entry["url"], format_spec, download_dir)
        results.append(info)

    await session.commit()

    if skipped_titles:
        preview = ", ".join(skipped_titles[:3])
        if len(skipped_titles) > 3:
            preview += f" (+{len(skipped_titles) - 3} more)"
        await create_notification(
            kind="completed",
            title=f"{len(skipped_titles)} file(s) already exist — skipped",
            body=preview,
            payload={"skipped": True, "count": len(skipped_titles)},
        )

    return results


@router.get("", response_model=list[DownloadInfo])
async def list_downloads(session: AsyncSession = Depends(get_session)) -> list[DownloadInfo]:
    result = await session.execute(select(Download).order_by(Download.created_at.desc()))
    return [DownloadInfo.model_validate(d) for d in result.scalars()]


@router.get("/grouped")
async def list_grouped_downloads(session: AsyncSession = Depends(get_session)) -> dict:
    """Return downloads grouped by subscription and manual downloads separately.

    Subscribed downloads are grouped by subscription_id with subscription details.
    Manual downloads (subscription_id is NULL) are returned in a separate list.
    """
    from app.models import Subscription

    # Get all subscriptions to build a lookup map
    sub_result = await session.execute(select(Subscription))
    subs_by_id = {s.id: s for s in sub_result.scalars()}

    # Get all downloads, grouped in-memory by subscription_id
    dl_result = await session.execute(select(Download).order_by(Download.created_at.desc()))
    downloads = [DownloadInfo.model_validate(d) for d in dl_result.scalars()]

    groups: dict[int, list[DownloadInfo]] = {}
    manual_downloads: list[DownloadInfo] = []

    for dl in downloads:
        if dl.subscription_id is not None:
            if dl.subscription_id not in groups:
                groups[dl.subscription_id] = []
            groups[dl.subscription_id].append(dl)
        else:
            manual_downloads.append(dl)

    # Build grouped response
    by_subscription = []
    for sub_id in sorted(groups.keys(), key=lambda sid: subs_by_id.get(sid, Subscription()).id or 0, reverse=True):
        sub = subs_by_id.get(sub_id)
        by_subscription.append({
            "subscription_id": sub_id,
            "subscription_title": sub.title if sub else f"Subscription {sub_id}",
            "download_count": len(groups[sub_id]),
            "downloads": groups[sub_id],
        })

    return {
        "by_subscription": by_subscription,
        "manual_downloads": manual_downloads,
    }


@router.get("/tags")
async def list_tags(session: AsyncSession = Depends(get_session)) -> dict:
    """Return all used tags grouped by category.

    Only returns non-empty tags. Categories without any tagged downloads
    are omitted from the response.
    """
    # Get all completed downloads (only show tags for files that exist)
    result = await session.execute(
        select(Download.category, Download.tag).where(
            Download.status == "completed",
            Download.tag.isnot(None),
        )
    )

    # Group tags by category
    tags_by_category: dict[str, set[str]] = {}
    for category, tag in result:
        if category and tag:
            if category not in tags_by_category:
                tags_by_category[category] = set()
            tags_by_category[category].add(tag)

    # Convert sets to sorted lists
    return {
        "tags": {
            cat: sorted(tags) for cat, tags in tags_by_category.items()
        }
    }


@router.get("/export")
async def export_downloads(session: AsyncSession = Depends(get_session)) -> Response:
    """Export all download URLs as newline-separated text."""
    result = await session.execute(
        select(Download.url).order_by(Download.created_at.desc())
    )
    urls = "\n".join(result.scalars())
    return Response(content=urls, media_type="text/plain")


# Default seed categories users get even before they've created any download —
# matches the example structure (TV/Movie/Music/Learning) the user described.
_DEFAULT_CATEGORIES = ("TV", "Movie", "Music", "Learning")


@router.get("/categories")
async def list_categories(session: AsyncSession = Depends(get_session)) -> dict:
    """Return the {category: {subcategory: [tags]}} tree built from existing
    downloads + subscriptions. Used to populate the autocomplete UI.

    Empty levels are pruned. Default seed categories are merged in so the
    dropdown is never empty for new users.
    """
    from app.models import Subscription

    tree: dict[str, dict[str, set[str]]] = {
        cat: {} for cat in _DEFAULT_CATEGORIES
    }

    def _add(cat: str | None, sub: str | None, tag: str | None) -> None:
        if not cat:
            return
        cat_node = tree.setdefault(cat, {})
        if sub:
            tag_set = cat_node.setdefault(sub, set())
            if tag:
                tag_set.add(tag)

    dl_rows = await session.execute(
        select(Download.category, Download.subcategory, Download.tag)
    )
    for cat, sub, tag in dl_rows:
        _add(cat, sub, tag)

    sub_rows = await session.execute(
        select(Subscription.category, Subscription.subcategory, Subscription.tag)
    )
    for cat, sub, tag in sub_rows:
        _add(cat, sub, tag)

    # Convert sets → sorted lists for JSON serialization.
    return {
        "categories": {
            cat: {sub: sorted(tags) for sub, tags in subs.items()}
            for cat, subs in tree.items()
        }
    }


@router.get("/{download_id}/open")
async def open_download(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Open the downloaded file's containing folder (cross-platform).

    Windows  → explorer /select,<file>
    macOS    → open -R <file>
    Linux    → xdg-open <folder>
    Headless containers that lack any of these return 501.
    """
    import os
    import shutil
    import subprocess
    import sys

    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")

    filepath = _resolve_output_path(download.output_path)
    if not filepath:
        raise HTTPException(status_code=404, detail="File not found on disk")

    folder = os.path.dirname(filepath)

    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", f"/select,{filepath}"])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", filepath])
        else:
            if not shutil.which("xdg-open"):
                raise HTTPException(
                    status_code=501,
                    detail="No file manager available on this host (headless container?). Use the Play button instead.",
                )
            subprocess.Popen(["xdg-open", folder])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to open file manager: {exc}")

    return Response(status_code=204)


def _resolve_output_path(stored: str | None) -> str | None:
    """Return an existing on-disk path for a download, tolerating post-merge
    path rewrites.

    yt-dlp's progress hook reports the pre-merge fragment filename
    (e.g. ``Title.f251.webm``) rather than the final merged file
    (``Title.mp4``). We normalize both the stored name and each candidate
    by stripping ``.f<digits>`` format-code suffixes before comparing.
    """
    import os
    import re

    if not stored:
        return None
    if os.path.exists(stored):
        return os.path.abspath(stored)

    fcode_re = re.compile(r"\.f\d+$")

    def _normalize(name: str) -> str:
        stem = os.path.splitext(name)[0]
        # strip a trailing .f<digits> once, if present
        return fcode_re.sub("", stem)

    folder = os.path.dirname(stored) or "."
    target = _normalize(os.path.basename(stored))
    if not os.path.isdir(folder):
        return None

    # Prefer common merged containers first, then anything else with a match.
    candidates: list[str] = []
    for name in os.listdir(folder):
        if _normalize(name) == target:
            candidates.append(name)

    def _rank(name: str) -> int:
        ext = os.path.splitext(name)[1].lower()
        return {".mp4": 0, ".mkv": 1, ".webm": 2, ".m4a": 3, ".mp3": 4}.get(ext, 9)

    for name in sorted(candidates, key=_rank):
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


@router.get("/{download_id}/file")
async def download_file(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    """Serve the downloaded file as an HTTP attachment so the browser saves
    it to disk instead of playing it inline. Used by the "Download file"
    action in the completed-downloads list — replaces the previous
    "Open in file explorer" affordance, which only worked on the host machine.
    """
    import os

    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")

    filepath = _resolve_output_path(download.output_path)
    if not filepath:
        raise HTTPException(status_code=404, detail="File not found on disk")

    media_type, _ = mimetypes.guess_type(filepath)
    if media_type is None:
        media_type = "application/octet-stream"

    return FileResponse(
        filepath,
        media_type=media_type,
        filename=os.path.basename(filepath),
        content_disposition_type="attachment",
    )


@router.get("/{download_id}/stream")
async def stream_download(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    """Stream the downloaded file inline so it plays directly in a browser tab.

    Starlette's FileResponse handles HTTP Range natively → the browser's
    native <video> element gets seek support for free.
    """
    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")

    filepath = _resolve_output_path(download.output_path)
    if not filepath:
        raise HTTPException(status_code=404, detail="File not found on disk")

    media_type, _ = mimetypes.guess_type(filepath)
    if media_type is None:
        media_type = "application/octet-stream"

    # content_disposition_type="inline" tells the browser to render the file
    # in-page instead of triggering a download. Without this, FileResponse
    # defaults to "attachment" whenever a filename is supplied.
    return FileResponse(
        filepath,
        media_type=media_type,
        content_disposition_type="inline",
    )


@router.get("/{download_id}", response_model=DownloadInfo)
async def get_download(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> DownloadInfo:
    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")
    return DownloadInfo.model_validate(download)


@router.delete("/{download_id}", status_code=204)
async def delete_download(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> None:
    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")
    await download_manager.cancel(download_id)
    await session.delete(download)
    await session.commit()
