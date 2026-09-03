import asyncio
import mimetypes
import pathlib
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Download, SeenVideo, Subscription
from app.schemas import DownloadCreateRequest, DownloadInfo, MetadataResolveRequest, PlaylistEntry
from app.services.download_manager import download_manager
from app.services.notifications import create_notification
from app.utils import category_subdir, find_existing_file, safe_folder_name
from app.ws import emit_download_added, emit_download_completed, emit_download_updated

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
        output_dir=download_dir,
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

    await download_manager.enqueue(download.id, req.url, format_spec, download_dir)
    return info


class PlaylistDownloadRequest(BaseModel):
    url: str
    format_spec: str = "bestvideo*+bestaudio/best"
    # When provided, only entries whose URL is in this list are downloaded.
    # Lets the UI show the full playlist and let the user drop videos first.
    urls: list[str] | None = None
    # Optional: title + entries already fetched by the client's review step,
    # so the server doesn't re-extract the (possibly huge) playlist.
    title: str | None = None
    entries: list[PlaylistEntry] | None = None
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None


class PlaylistPreviewJob(BaseModel):
    job_id: str
    status: str  # pending | done | error
    title: str | None = None
    entries: list[PlaylistEntry] | None = None
    error: str | None = None


def _dedupe_entries(entries: list[dict]) -> list[dict]:
    _seen: set[str] = set()
    out: list[dict] = []
    for entry in entries:
        vid = entry.get("id")
        if not vid or vid in _seen:
            continue
        _seen.add(vid)
        out.append(entry)
    return out


async def _extract_deduped_playlist(url: str) -> dict:
    """Flat-extract a playlist and drop duplicate video ids."""
    from app.ytdl.service import extract_playlist

    try:
        playlist_data = await asyncio.to_thread(extract_playlist, url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    playlist_data["entries"] = _dedupe_entries(playlist_data["entries"])
    return playlist_data


# ── Async playlist preview ───────────────────────────────────────────────────
# Extracting a large channel/playlist can take minutes — longer than a
# reverse-proxy (Cloudflare) will hold a request open (HTTP 524). So the
# preview runs as a background job the client polls with short, fast requests.

_PREVIEW_JOBS: dict[str, dict] = {}
_PREVIEW_TTL_SECONDS = 900


def _gc_preview_jobs() -> None:
    now = time.time()
    for key in [k for k, v in _PREVIEW_JOBS.items() if now - v["created"] > _PREVIEW_TTL_SECONDS]:
        _PREVIEW_JOBS.pop(key, None)


async def _run_preview_job(job_id: str, url: str) -> None:
    from app.ytdl.service import extract_playlist

    try:
        data = await asyncio.to_thread(extract_playlist, url)
        _PREVIEW_JOBS[job_id].update(
            status="done",
            title=data.get("title") or "Playlist",
            entries=_dedupe_entries(data.get("entries") or []),
        )
    except Exception as exc:  # noqa: BLE001 — surface any yt-dlp failure to the client
        _PREVIEW_JOBS[job_id].update(status="error", error=str(exc))


@router.post("/playlist/preview", response_model=PlaylistPreviewJob, status_code=202)
async def start_playlist_preview(req: MetadataResolveRequest) -> PlaylistPreviewJob:
    """Kick off a background playlist extraction; poll /playlist/preview/{job_id}."""
    _gc_preview_jobs()
    job_id = uuid.uuid4().hex
    job: dict = {"status": "pending", "created": time.time()}
    _PREVIEW_JOBS[job_id] = job
    job["task"] = asyncio.create_task(_run_preview_job(job_id, req.url))
    return PlaylistPreviewJob(job_id=job_id, status="pending")


@router.get("/playlist/preview/{job_id}", response_model=PlaylistPreviewJob)
async def get_playlist_preview(job_id: str) -> PlaylistPreviewJob:
    job = _PREVIEW_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Preview job not found or expired")
    return PlaylistPreviewJob(
        job_id=job_id,
        status=job["status"],
        title=job.get("title"),
        entries=[PlaylistEntry(**e) for e in job["entries"]] if job.get("entries") else None,
        error=job.get("error"),
    )


@router.post("/playlist", response_model=list[DownloadInfo], status_code=201)
async def download_playlist(
    req: PlaylistDownloadRequest,
    session: AsyncSession = Depends(get_session),
) -> list[DownloadInfo]:
    """Create a folder and enqueue downloads for a playlist's videos.

    If the URL is already subscribed, downloads are linked to that subscription
    (grouped, and already-seen videos are skipped). If the client already
    fetched the playlist (review step) it passes `title` + `entries` and the
    server skips re-extraction.
    """
    if req.entries is not None and req.title:
        playlist_data = {
            "title": req.title,
            "entries": _dedupe_entries([e.model_dump() for e in req.entries]),
        }
    else:
        playlist_data = await _extract_deduped_playlist(req.url)

    # Restrict to the caller's selection, if one was sent (review step).
    if req.urls is not None:
        keep = set(req.urls)
        playlist_data["entries"] = [
            e for e in playlist_data["entries"] if e["url"] in keep
        ]

    # Check if this playlist URL is already subscribed to
    sub_row = await session.execute(
        select(Subscription).where(Subscription.url == req.url)
    )
    subscription = sub_row.scalars().first()

    # If subscribed, load already-seen video IDs to prevent re-downloading
    seen_video_ids: set[str] = set()
    if subscription:
        seen_rows = await session.execute(
            select(SeenVideo.video_id).where(SeenVideo.subscription_id == subscription.id)
        )
        seen_video_ids = set(seen_rows.scalars().all())

    # Dedupe by video id so a playlist that lists the same video twice
    # doesn't enqueue two downloads writing to the same output path.
    # Also skip videos already seen by the subscription.
    _seen: set[str] = set()
    deduped: list[dict] = []
    for entry in playlist_data["entries"]:
        vid = entry.get("id")
        if not vid or vid in _seen or vid in seen_video_ids:
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
            output_dir=download_dir,
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


@router.get("/status")
async def downloads_status() -> dict:
    """Queue state — notably whether downloads are paused and why."""
    return download_manager.status


@router.post("/pause-all")
async def pause_all_downloads() -> dict:
    """Pause all active and queued downloads."""
    await download_manager.pause("Paused by user")
    return download_manager.status


@router.post("/resume-incomplete")
async def resume_incomplete_downloads() -> dict:
    """Lift any pause and re-enqueue downloads stuck in queued/downloading."""
    count = await download_manager.resume_incomplete()
    return {"resumed": count, "paused": download_manager.status["paused"]}


@router.post("/pad-episodes")
async def pad_episode_numbers_endpoint(session: AsyncSession = Depends(get_session)) -> dict:
    """Zero-pad single-digit episode numbers across every download folder.

    Walks DOWNLOAD_DIR, applies rename.sh's logic ("Episode 1" → "Episode 01",
    episodes 10+ untouched), and updates matching download rows' output_path.
    """
    import os

    from app.utils import pad_episode_files

    root = settings.DOWNLOAD_DIR
    renamed: list[dict] = []
    for folder, _dirs, _files in os.walk(root):
        for old, new in pad_episode_files(folder):
            old_abs = os.path.join(folder, old)
            new_abs = os.path.join(folder, new)
            renamed.append({"from": old, "to": new, "dir": folder})
            await session.execute(
                Download.__table__.update()
                .where(Download.output_path == old_abs)
                .values(output_path=new_abs)
            )
    await session.commit()
    return {"renamed": len(renamed), "changes": renamed[:200]}


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


@router.post("/{download_id}/retry", response_model=DownloadInfo)
async def retry_download(
    download_id: int,
    session: AsyncSession = Depends(get_session),
) -> DownloadInfo:
    """Re-queue a failed or canceled download, reusing its original settings."""
    import os

    from app.models import Subscription
    from app.utils import subscription_download_dir

    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")
    if download.status in ("queued", "downloading"):
        raise HTTPException(status_code=409, detail="Download is already active")

    # Where to write: the stored dir → the subscription folder → the folder the
    # previous attempt targeted → the app default.
    output_dir: str | None = download.output_dir
    if not output_dir and download.subscription_id is not None:
        sub = await session.get(Subscription, download.subscription_id)
        if sub is not None:
            output_dir = subscription_download_dir(sub, settings.DOWNLOAD_DIR)
    if not output_dir and download.output_path:
        output_dir = os.path.dirname(download.output_path) or None

    download.status = "queued"
    download.percent = 0.0
    download.error_message = None
    download.speed = None
    download.eta = None
    if output_dir:
        download.output_dir = output_dir
    await session.commit()
    await session.refresh(download)

    info = DownloadInfo.model_validate(download)
    await emit_download_updated(info.model_dump(mode="json"))

    format_spec = download.format_spec or "bestvideo*+bestaudio/best"
    await download_manager.enqueue(download.id, download.url, format_spec, output_dir)
    return info


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
