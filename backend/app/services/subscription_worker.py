"""
Subscription Worker — APScheduler-based playlist polling.

Module-level AsyncIOScheduler singleton started during app lifespan.
Each active subscription gets an interval job keyed as "sub_{id}".
"""

import asyncio
import logging
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import Download, SeenVideo, Subscription
from app.services.notifications import create_notification
from app.ws import emit_subscription_checked, emit_subscription_new_video

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler(timezone="UTC")
    return _scheduler


async def check_subscription(subscription_id: int) -> None:
    """
    APScheduler job: re-extract flat playlist, diff against seen_videos,
    insert new rows, emit WS events, and enqueue downloads for new videos.
    """
    from app.ytdl.service import extract_playlist
    from app.services.download_manager import download_manager
    from app.schemas import DownloadInfo
    from app.ws import emit_download_added

    SessionLocal = get_sessionmaker()

    # Load subscription
    async with SessionLocal() as session:
        sub = await session.get(Subscription, subscription_id)
        if sub is None or not sub.is_active:
            return
        url = sub.url
        format_spec = sub.format_spec or "bestvideo*+bestaudio/best"
        sub_title = sub.title or url
        download_dir = sub.download_dir
        notify_enabled = sub.notify

    # Extract flat playlist in a thread (blocking I/O)
    try:
        playlist_data = await asyncio.to_thread(extract_playlist, url)
    except Exception as exc:
        logger.error("Subscription %s check failed: %s", subscription_id, exc)
        if notify_enabled:
            await create_notification(
                kind="subscription_error",
                title=f"Subscription check failed: {sub_title}",
                body=str(exc),
                payload={"subscription_id": subscription_id},
            )
        return

    entries = playlist_data["entries"]
    new_count = 0

    async with SessionLocal() as session:
        # Current seen IDs
        result = await session.execute(
            select(SeenVideo.video_id).where(SeenVideo.subscription_id == subscription_id)
        )
        seen_ids = set(result.scalars())

        new_entries = [e for e in entries if e["id"] not in seen_ids]

        for entry in new_entries:
            video_id = entry["id"]
            video_url = entry["url"]
            video_title = entry.get("title")
            upload_date = entry.get("upload_date")

            # Mark as seen
            seen = SeenVideo(
                subscription_id=subscription_id,
                video_id=video_id,
                title=video_title,
                upload_date=upload_date,
            )
            session.add(seen)

            # Create queued download
            dl = Download(
                url=video_url,
                title=video_title,
                format_spec=format_spec,
                status="queued",
                percent=0.0,
                subscription_id=subscription_id,
            )
            session.add(dl)
            await session.flush()  # populate dl.id before committing

            # Emit new_video event
            await emit_subscription_new_video({
                "subscription_id": subscription_id,
                "video_id": video_id,
                "title": video_title,
            })

            # Emit download:added and enqueue
            dl_info = DownloadInfo.model_validate(dl)
            await emit_download_added(dl_info.model_dump(mode="json"))
            await download_manager.enqueue(dl.id, video_url, format_spec, download_dir)

            new_count += 1

        # Update last_checked_at
        sub = await session.get(Subscription, subscription_id)
        if sub:
            sub.last_checked_at = datetime.utcnow()

        await session.commit()

    now_iso = datetime.utcnow().isoformat()
    await emit_subscription_checked({
        "id": subscription_id,
        "new_count": new_count,
        "last_checked_at": now_iso,
    })

    if new_count > 0 and notify_enabled:
        await create_notification(
            kind="new_video",
            title=f"{new_count} new video{'s' if new_count != 1 else ''} from {sub_title}",
            body=None,
            payload={"subscription_id": subscription_id, "new_count": new_count},
        )


async def schedule_subscription(sub: Subscription) -> None:
    """Register (or re-register) an APScheduler job for this subscription."""
    scheduler = get_scheduler()
    job_id = f"sub_{sub.id}"

    existing = scheduler.get_job(job_id)
    if existing:
        scheduler.remove_job(job_id)

    if sub.is_active:
        scheduler.add_job(
            check_subscription,
            trigger="interval",
            minutes=sub.check_interval_minutes,
            id=job_id,
            args=[sub.id],
            replace_existing=True,
        )


async def unschedule_subscription(subscription_id: int) -> None:
    """Remove the APScheduler job for a subscription."""
    scheduler = get_scheduler()
    job_id = f"sub_{subscription_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)


async def start_scheduler() -> None:
    """Start scheduler and register jobs for all active subscriptions."""
    scheduler = get_scheduler()
    scheduler.start()

    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        result = await session.execute(
            select(Subscription).where(Subscription.is_active == True)  # noqa: E712
        )
        subs = list(result.scalars())

    for sub in subs:
        await schedule_subscription(sub)


async def stop_scheduler() -> None:
    scheduler = get_scheduler()
    if scheduler.running:
        scheduler.shutdown(wait=False)
