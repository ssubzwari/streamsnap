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
from app.utils import find_existing_file, safe_folder_name

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

    # Reject duplicates up front — one row per URL keeps the scheduler
    # from polling the same playlist twice and the UI from listing ghosts.
    existing = await session.execute(
        select(Subscription).where(Subscription.url == req.url)
    )
    if existing.scalars().first() is not None:
        raise HTTPException(
            status_code=409,
            detail="You're already subscribed to this playlist.",
        )

    # Get the flat playlist. Prefer the entries the client already fetched in
    # its review step — re-extracting a large channel here can exceed the
    # reverse-proxy timeout (HTTP 524).
    if req.entries is not None and req.playlist_title:
        playlist_data = {
            "title": req.playlist_title,
            "entries": [e.model_dump() for e in req.entries],
        }
    else:
        try:
            playlist_data = await asyncio.to_thread(extract_playlist, req.url)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    # Dedupe entries by video id. Some playlists (especially "Latest" /
    # community channel tabs) surface the same video twice, which would
    # violate seen_videos(subscription_id, video_id) UNIQUE on insert.
    _seen_ids: set[str] = set()
    deduped_entries: list[dict] = []
    for entry in playlist_data["entries"]:
        vid = entry.get("id")
        if not vid or vid in _seen_ids:
            continue
        _seen_ids.add(vid)
        deduped_entries.append(entry)
    playlist_data["entries"] = deduped_entries

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
        notify=req.notify,
    )
    session.add(sub)
    # Flush (not commit) so sub.id is assigned while we're still in one
    # atomic transaction. If the seen_videos backfill or download enqueue
    # raises below, the whole subscription rolls back — no orphan row left
    # behind to block the user from retrying under the 409 dedupe check.
    await session.flush()

    # Backfill seen_videos
    for entry in playlist_data["entries"]:
        seen = SeenVideo(
            subscription_id=sub.id,
            video_id=entry["id"],
            title=entry.get("title"),
            upload_date=entry.get("upload_date"),
        )
        session.add(seen)

    selected_ids = (
        set(req.download_video_ids) if req.download_video_ids is not None else None
    )
    if req.download_existing:
        from app.ws import emit_download_completed
        for entry in playlist_data["entries"]:
            if selected_ids is not None and entry["id"] not in selected_ids:
                continue
            title = entry.get("title")
            # Skip re-downloads when the file already sits in this
            # subscription's folder (e.g. imported manually, or carried over
            # from a previous subscription under the same name).
            existing_path = find_existing_file(download_dir, title)
            dl = Download(
                url=entry["url"],
                title=title,
                format_spec=format_spec,
                status="completed" if existing_path else "queued",
                percent=100.0 if existing_path else 0.0,
                output_dir=download_dir,
                output_path=existing_path,
                subscription_id=sub.id,
            )
            session.add(dl)
            await session.flush()
            dl_info = DownloadInfo.model_validate(dl)
            await emit_download_added(dl_info.model_dump(mode="json"))
            if existing_path:
                await emit_download_completed(dl_info.model_dump(mode="json"))
            else:
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
    if req.notify is not None:
        sub.notify = req.notify

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
    from sqlalchemy import delete as sa_delete
    from app.models import Download

    sub = await session.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    await unschedule_subscription(sub_id)

    # Cascade manually — SQLite reuses primary keys after DELETE, so leaving
    # orphan seen_videos / downloads rows behind would make a future
    # subscription with the same reused id collide on
    # seen_videos(subscription_id, video_id) UNIQUE.
    await session.execute(sa_delete(SeenVideo).where(SeenVideo.subscription_id == sub_id))
    await session.execute(sa_delete(Download).where(Download.subscription_id == sub_id))
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
