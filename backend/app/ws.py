import socketio

from app.config import settings
from app.events import (
    DOWNLOAD_ADDED,
    DOWNLOAD_CANCELED,
    DOWNLOAD_COMPLETED,
    DOWNLOAD_FAILED,
    DOWNLOAD_UPDATED,
    DOWNLOADS_PAUSED,
    NOTIFICATION_CREATED,
    SUBSCRIPTION_CHECKED,
    SUBSCRIPTION_NEW_VIDEO,
)

# Same-origin connections (the browser loading the bundled frontend) always
# work. CORS_ORIGINS only needs entries for cross-origin clients such as the
# Vite dev server on :5173. Empty list → allow any origin (see config.py).
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=settings.cors_origin_list or "*",
    logger=False,
    engineio_logger=False,
)


@sio.event
async def connect(sid: str, environ: dict, auth: dict | None = None) -> None:
    pass


@sio.event
async def disconnect(sid: str) -> None:
    pass


# ── Download events ───────────────────────────────────────────────────────────

async def emit_download_added(payload: dict) -> None:
    await sio.emit(DOWNLOAD_ADDED, payload)


async def emit_download_updated(payload: dict) -> None:
    await sio.emit(DOWNLOAD_UPDATED, payload)


async def emit_download_completed(payload: dict) -> None:
    await sio.emit(DOWNLOAD_COMPLETED, payload)


async def emit_download_failed(payload: dict) -> None:
    await sio.emit(DOWNLOAD_FAILED, payload)


async def emit_download_canceled(payload: dict) -> None:
    await sio.emit(DOWNLOAD_CANCELED, payload)


async def emit_downloads_paused(payload: dict) -> None:
    await sio.emit(DOWNLOADS_PAUSED, payload)


# ── Subscription events ───────────────────────────────────────────────────────

async def emit_subscription_checked(payload: dict) -> None:
    await sio.emit(SUBSCRIPTION_CHECKED, payload)


async def emit_subscription_new_video(payload: dict) -> None:
    await sio.emit(SUBSCRIPTION_NEW_VIDEO, payload)


# ── Notification events ───────────────────────────────────────────────────────

async def emit_notification_created(payload: dict) -> None:
    await sio.emit(NOTIFICATION_CREATED, payload)
