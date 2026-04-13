import asyncio
import pathlib

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Download
from app.schemas import DownloadCreateRequest, DownloadInfo
from app.services.download_manager import download_manager
from app.utils import safe_folder_name
from app.ws import emit_download_added

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


@router.post("", response_model=DownloadInfo, status_code=201)
async def create_download(
    req: DownloadCreateRequest,
    session: AsyncSession = Depends(get_session),
) -> DownloadInfo:
    download = Download(
        url=req.url,
        title=req.title,
        thumbnail=req.thumbnail,
        duration=req.duration,
        format_spec=req.format_spec,
        status="queued",
        percent=0.0,
    )
    session.add(download)
    await session.commit()
    await session.refresh(download)

    info = DownloadInfo.model_validate(download)
    await emit_download_added(info.model_dump(mode="json"))
    await download_manager.enqueue(download.id, req.url, req.format_spec)
    return info


class PlaylistDownloadRequest(BaseModel):
    url: str
    format_spec: str = "bestvideo*+bestaudio/best"


@router.post("/playlist", response_model=list[DownloadInfo], status_code=201)
async def download_playlist(
    req: PlaylistDownloadRequest,
    session: AsyncSession = Depends(get_session),
) -> list[DownloadInfo]:
    """Extract all videos from a playlist, create a folder, and enqueue downloads."""
    from app.ytdl.service import extract_playlist

    try:
        playlist_data = await asyncio.to_thread(extract_playlist, req.url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Create per-playlist folder
    folder_name = safe_folder_name(playlist_data["title"])
    download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / folder_name)
    pathlib.Path(download_dir).mkdir(parents=True, exist_ok=True)

    results: list[DownloadInfo] = []
    for entry in playlist_data["entries"]:
        dl = Download(
            url=entry["url"],
            title=entry.get("title"),
            format_spec=req.format_spec,
            status="queued",
            percent=0.0,
        )
        session.add(dl)
        await session.flush()

        info = DownloadInfo.model_validate(dl)
        await emit_download_added(info.model_dump(mode="json"))
        await download_manager.enqueue(dl.id, entry["url"], req.format_spec, download_dir)
        results.append(info)

    await session.commit()
    return results


@router.get("", response_model=list[DownloadInfo])
async def list_downloads(session: AsyncSession = Depends(get_session)) -> list[DownloadInfo]:
    result = await session.execute(select(Download).order_by(Download.created_at.desc()))
    return [DownloadInfo.model_validate(d) for d in result.scalars()]


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
    """Open the downloaded file's containing folder."""
    import os
    import subprocess

    download = await session.get(Download, download_id)
    if not download:
        raise HTTPException(status_code=404, detail="Download not found")
    if not download.output_path or not os.path.exists(download.output_path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    # Open the containing folder with the file selected (Windows)
    folder = os.path.dirname(os.path.abspath(download.output_path))
    filepath = os.path.abspath(download.output_path)
    try:
        subprocess.Popen(["explorer", "/select,", filepath])
    except Exception:
        subprocess.Popen(["explorer", folder])

    return Response(status_code=204)


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
