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
from app.models import Download
from app.schemas import DownloadCreateRequest, DownloadInfo, MetadataResolveRequest, PlaylistEntry
from app.services.download_manager import download_manager
from app.services.notifications import create_notification
from app.utils import find_existing_file, safe_folder_name
from app.ws import emit_download_added, emit_download_completed, emit_download_updated

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


@router.post("", response_model=DownloadInfo, status_code=201)
async def create_download(
    req: DownloadCreateRequest,
    session: AsyncSession = Depends(get_session),
) -> DownloadInfo:
    # Probe the download folder *before* enqueuing. If a file with the same
    # title is already on disk (from a previous run, a manual copy, or a DB
    # wipe that left the files behind), record a completed row pointing at
    # the existing file instead of re-downloading.
    existing_path = find_existing_file(settings.DOWNLOAD_DIR, req.title)

    download = Download(
        url=req.url,
        title=req.title,
        thumbnail=req.thumbnail,
        duration=req.duration,
        format_spec=req.format_spec,
        status="completed" if existing_path else "queued",
        percent=100.0 if existing_path else 0.0,
        output_path=existing_path,
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

    await download_manager.enqueue(download.id, req.url, req.format_spec)
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

    If the client already fetched the playlist (review step) it passes
    `title` + `entries` and the server skips re-extraction.
    """
    if req.entries is not None and req.title:
        playlist_data = {
            "title": req.title,
            "entries": _dedupe_entries([e.model_dump() for e in req.entries]),
        }
    else:
        playlist_data = await _extract_deduped_playlist(req.url)

    # Restrict to the caller's selection, if one was sent.
    if req.urls is not None:
        keep = set(req.urls)
        playlist_data["entries"] = [
            e for e in playlist_data["entries"] if e["url"] in keep
        ]

    # Create per-playlist folder
    folder_name = safe_folder_name(playlist_data["title"])
    download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / folder_name)
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
            format_spec=req.format_spec,
            status="completed" if existing_path else "queued",
            percent=100.0 if existing_path else 0.0,
            output_dir=download_dir,
            output_path=existing_path,
        )
        session.add(dl)
        await session.flush()

        info = DownloadInfo.model_validate(dl)
        await emit_download_added(info.model_dump(mode="json"))

        if existing_path:
            await emit_download_completed(info.model_dump(mode="json"))
            skipped_titles.append(title or entry["url"])
        else:
            await download_manager.enqueue(dl.id, entry["url"], req.format_spec, download_dir)
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


@router.post("/resume-incomplete")
async def resume_incomplete_downloads() -> dict:
    """Lift any pause and re-enqueue downloads stuck in queued/downloading."""
    count = await download_manager.resume_incomplete()
    return {"resumed": count, "paused": download_manager.status["paused"]}


@router.get("/export")
async def export_downloads(session: AsyncSession = Depends(get_session)) -> Response:
    """Export all download URLs as newline-separated text."""
    result = await session.execute(
        select(Download.url).order_by(Download.created_at.desc())
    )
    urls = "\n".join(result.scalars())
    return Response(content=urls, media_type="text/plain")


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
