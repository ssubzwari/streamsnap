from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Notification
from app.schemas import NotificationInfo

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
