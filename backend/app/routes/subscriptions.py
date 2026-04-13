import asyncio
import pathlib

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import SeenVideo, Subscription
from app.schemas import SubscriptionCreate, SubscriptionInfo, SubscriptionUpdate
from app.services.subscription_worker import schedule_subscription, unschedule_subscription
from app.utils import safe_folder_name

router = APIRouter(prefix="/api/subscriptions", tags=["subscriptions"])


@router.post("", response_model=SubscriptionInfo, status_code=201)
async def create_subscription(
    req: SubscriptionCreate,
    session: AsyncSession = Depends(get_session),
) -> SubscriptionInfo:
    from app.ytdl.service import extract_playlist, _is_ffmpeg_available
    from app.services.download_manager import download_manager
    from app.models import Download
    from app.ws import emit_download_added
    from app.schemas import DownloadInfo

    # Extract flat playlist (blocking — run in thread)
    try:
        playlist_data = await asyncio.to_thread(extract_playlist, req.url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Create per-playlist download folder
    folder_name = safe_folder_name(playlist_data["title"])
    download_dir = str(pathlib.Path(settings.DOWNLOAD_DIR) / folder_name)
    pathlib.Path(download_dir).mkdir(parents=True, exist_ok=True)

    # Pick best format spec: merge when ffmpeg available, single-stream fallback otherwise
    format_spec = req.format_spec
    if format_spec == "best":
        format_spec = "bestvideo+bestaudio/best" if _is_ffmpeg_available() else "best"

    sub = Subscription(
        url=req.url,
        title=playlist_data["title"],
        check_interval_minutes=req.check_interval_minutes,
        format_spec=format_spec,
        output_template=req.output_template,
        is_active=True,
        download_existing=req.download_existing,
        download_dir=download_dir,
    )
    session.add(sub)
    await session.commit()
    await session.refresh(sub)

    # Backfill seen_videos
    for entry in playlist_data["entries"]:
        seen = SeenVideo(
            subscription_id=sub.id,
            video_id=entry["id"],
            title=entry.get("title"),
            upload_date=entry.get("upload_date"),
        )
        session.add(seen)

    if req.download_existing:
        for entry in playlist_data["entries"]:
            dl = Download(
                url=entry["url"],
                title=entry.get("title"),
                format_spec=format_spec,
                status="queued",
                percent=0.0,
                subscription_id=sub.id,
            )
            session.add(dl)
            await session.flush()
            dl_info = DownloadInfo.model_validate(dl)
            await emit_download_added(dl_info.model_dump(mode="json"))
            await download_manager.enqueue(dl.id, entry["url"], format_spec, download_dir)

    await session.commit()

    # Register APScheduler job
    await schedule_subscription(sub)

    return SubscriptionInfo.model_validate(sub)


@router.get("", response_model=list[SubscriptionInfo])
async def list_subscriptions(
    session: AsyncSession = Depends(get_session),
) -> list[SubscriptionInfo]:
    result = await session.execute(select(Subscription).order_by(Subscription.created_at.desc()))
    return [SubscriptionInfo.model_validate(s) for s in result.scalars()]


@router.get("/{sub_id}", response_model=SubscriptionInfo)
async def get_subscription(
    sub_id: int,
    session: AsyncSession = Depends(get_session),
) -> SubscriptionInfo:
    sub = await session.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return SubscriptionInfo.model_validate(sub)


@router.patch("/{sub_id}", response_model=SubscriptionInfo)
async def update_subscription(
    sub_id: int,
    req: SubscriptionUpdate,
    session: AsyncSession = Depends(get_session),
) -> SubscriptionInfo:
    sub = await session.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    if req.check_interval_minutes is not None:
        sub.check_interval_minutes = req.check_interval_minutes
    if req.format_spec is not None:
        sub.format_spec = req.format_spec
    if req.output_template is not None:
        sub.output_template = req.output_template
    if req.is_active is not None:
        sub.is_active = req.is_active

    await session.commit()
    await session.refresh(sub)

    # Re-register job with updated settings
    await schedule_subscription(sub)

    return SubscriptionInfo.model_validate(sub)


@router.delete("/{sub_id}", status_code=204)
async def delete_subscription(
    sub_id: int,
    session: AsyncSession = Depends(get_session),
) -> None:
    sub = await session.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    await unschedule_subscription(sub_id)
    await session.delete(sub)
    await session.commit()


@router.post("/{sub_id}/check", status_code=202)
async def manual_check(
    sub_id: int,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
) -> dict:
    sub = await session.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    from app.services.subscription_worker import check_subscription
    background_tasks.add_task(check_subscription, sub_id)
    return {"queued": True}
