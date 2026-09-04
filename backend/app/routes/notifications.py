from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Notification, NotificationChannel
from app.schemas import (
    NotificationChannelCreate,
    NotificationChannelInfo,
    NotificationChannelUpdate,
    NotificationInfo,
)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationInfo])
async def list_notifications(
    unread_only: bool = False,
    session: AsyncSession = Depends(get_session),
) -> list[NotificationInfo]:
    q = select(Notification).order_by(Notification.created_at.desc())
    if unread_only:
        q = q.where(Notification.is_read == False)  # noqa: E712
    result = await session.execute(q)
    return [NotificationInfo.model_validate(n) for n in result.scalars()]


@router.patch("/{notif_id}/read", response_model=NotificationInfo)
async def mark_read(
    notif_id: int,
    session: AsyncSession = Depends(get_session),
) -> NotificationInfo:
    notif = await session.get(Notification, notif_id)
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.is_read = True
    await session.commit()
    await session.refresh(notif)
    return NotificationInfo.model_validate(notif)


@router.post("/read-all", status_code=204)
async def mark_all_read(
    session: AsyncSession = Depends(get_session),
) -> None:
    await session.execute(update(Notification).values(is_read=True))
    await session.commit()


# ── Notification channels ─────────────────────────────────────────────────────

@router.get("/channels", response_model=list[NotificationChannelInfo])
async def list_channels(
    session: AsyncSession = Depends(get_session),
) -> list[NotificationChannelInfo]:
    result = await session.execute(
        select(NotificationChannel).order_by(NotificationChannel.created_at)
    )
    return [NotificationChannelInfo.model_validate(c) for c in result.scalars()]


@router.post("/channels", response_model=NotificationChannelInfo, status_code=201)
async def create_channel(
    body: NotificationChannelCreate,
    session: AsyncSession = Depends(get_session),
) -> NotificationChannelInfo:
    channel = NotificationChannel(**body.model_dump())
    session.add(channel)
    await session.commit()
    await session.refresh(channel)
    return NotificationChannelInfo.model_validate(channel)


@router.patch("/channels/{channel_id}", response_model=NotificationChannelInfo)
async def update_channel(
    channel_id: int,
    body: NotificationChannelUpdate,
    session: AsyncSession = Depends(get_session),
) -> NotificationChannelInfo:
    channel = await session.get(NotificationChannel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(channel, field, value)
    await session.commit()
    await session.refresh(channel)
    return NotificationChannelInfo.model_validate(channel)


@router.delete("/channels/{channel_id}", status_code=204)
async def delete_channel(
    channel_id: int,
    session: AsyncSession = Depends(get_session),
) -> None:
    channel = await session.get(NotificationChannel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    await session.delete(channel)
    await session.commit()


@router.post("/channels/{channel_id}/test", status_code=204)
async def test_channel(
    channel_id: int,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Send a test notification through the specified channel."""
    import json as _json
    channel = await session.get(NotificationChannel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    from app.services.external_notifier import _SENDERS
    sender = _SENDERS.get(channel.kind)
    if sender is None:
        raise HTTPException(status_code=400, detail=f"Unknown channel kind: {channel.kind}")
    cfg = _json.loads(channel.config_json or "{}")
    try:
        await sender(cfg, "StreamSnap test notification", "If you see this, the channel is working.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/summary", status_code=204)
async def send_summary_now() -> None:
    """Manually trigger a notification summary to all enabled channels."""
    from app.services.external_notifier import send_summary
    await send_summary()
