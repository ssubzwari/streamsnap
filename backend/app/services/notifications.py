"""
Notification dispatcher — creates a DB record and emits the WS event.
"""

import json

from app.db import get_sessionmaker
from app.models import Notification
from app.schemas import NotificationInfo
from app.ws import emit_notification_created


async def create_notification(
    kind: str,
    title: str,
    body: str | None = None,
    payload: dict | None = None,
) -> NotificationInfo:
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        notif = Notification(
            kind=kind,
            title=title,
            body=body,
            payload_json=json.dumps(payload) if payload else None,
        )
        session.add(notif)
        await session.commit()
        await session.refresh(notif)

    info = NotificationInfo.model_validate(notif)
    await emit_notification_created(info.model_dump(mode="json"))
    return info
