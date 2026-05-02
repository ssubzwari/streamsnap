"""
Notification dispatcher — creates a DB record and emits the WS event.

Centralized suppression: every kind has a setting flag that gates whether
the notification gets created at all. If the flag is "false" we short-circuit
before touching the DB or WS — keeps the toast UI quiet without each caller
having to check.
"""

import asyncio
import json

from app.db import get_sessionmaker
from app.models import Notification, Setting
from app.schemas import NotificationInfo
from app.ws import emit_notification_created


# Map notification kinds to the Setting key that gates them.
# Kinds not in this map are always created.
_GATE_KEYS: dict[str, str] = {
    "download_started":   "notify_on_download_start",
    "completed":          "notify_on_complete",
    "failed":             "notify_on_failed",
    "playlist_completed": "notify_on_playlist_complete",
    "new_video":          "notify_on_new_video",
    "subscription_error": "notify_on_subscription_error",
}

# Default-when-unset for each gate. Matches what the Settings UI seeds.
_GATE_DEFAULTS: dict[str, str] = {
    "notify_on_download_start":     "false",
    "notify_on_complete":           "true",
    "notify_on_failed":             "true",
    "notify_on_playlist_complete":  "true",
    "notify_on_new_video":          "false",
    "notify_on_subscription_error": "true",
}


async def _is_kind_enabled(kind: str) -> bool:
    key = _GATE_KEYS.get(kind)
    if key is None:
        return True
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        row = await session.get(Setting, key)
        value = row.value if row and row.value is not None else _GATE_DEFAULTS.get(key, "true")
    return value == "true"


async def create_notification(
    kind: str,
    title: str,
    body: str | None = None,
    thumbnail: str | None = None,
    payload: dict | None = None,
) -> NotificationInfo | None:
    if not await _is_kind_enabled(kind):
        return None

    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        notif = Notification(
            kind=kind,
            title=title,
            body=body,
            thumbnail=thumbnail,
            payload_json=json.dumps(payload) if payload else None,
        )
        session.add(notif)
        await session.commit()
        await session.refresh(notif)

    info = NotificationInfo.model_validate(notif)
    await emit_notification_created(info.model_dump(mode="json"))

    # Dispatch to external channels (fire-and-forget — never blocks the caller)
    from app.services.external_notifier import dispatch
    asyncio.create_task(dispatch(kind, title, body, thumbnail))

    return info
