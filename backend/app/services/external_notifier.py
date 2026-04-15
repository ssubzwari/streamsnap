"""
External notification dispatcher.

Called by create_notification() after the DB record is created and the
WebSocket event is emitted.  Loads all enabled NotificationChannel rows,
checks suppression settings, then dispatches to each channel asynchronously.
"""

import asyncio
import json
import logging
import smtplib
import ssl
from email.mime.text import MIMEText

import httpx

from app.db import get_sessionmaker

logger = logging.getLogger(__name__)

# Map notification kinds to their suppression setting key
_SUPPRESS_KEYS: dict[str, str] = {
    "completed":           "notify_on_complete",
    "failed":              "notify_on_failed",
    "new_video":           "notify_on_new_video",
    "subscription_error":  "notify_on_subscription_error",
}


async def _load_settings() -> dict[str, str]:
    from sqlalchemy import select
    from app.models import Setting
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        result = await session.execute(select(Setting))
        return {s.key: (s.value or "") for s in result.scalars()}


async def _load_channels() -> list[dict]:
    from sqlalchemy import select
    from app.models import NotificationChannel
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        result = await session.execute(
            select(NotificationChannel).where(NotificationChannel.is_enabled == True)  # noqa: E712
        )
        return [
            {"kind": c.kind, "config": json.loads(c.config_json or "{}")}
            for c in result.scalars()
        ]


def _is_suppressed(kind: str, settings: dict[str, str]) -> bool:
    key = _SUPPRESS_KEYS.get(kind)
    if key is None:
        return False
    # Suppressed when setting is explicitly "false"
    return settings.get(key, "true") == "false"


# ── Per-channel senders ───────────────────────────────────────────────────────

async def _send_slack(cfg: dict, title: str, body: str | None) -> None:
    text = f"*{title}*"
    if body:
        text += f"\n{body}"
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(cfg["webhook_url"], json={"text": text})


async def _send_discord(cfg: dict, title: str, body: str | None) -> None:
    content = f"**{title}**"
    if body:
        content += f"\n{body}"
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(cfg["webhook_url"], json={"content": content})


async def _send_telegram(cfg: dict, title: str, body: str | None) -> None:
    text = f"<b>{title}</b>"
    if body:
        text += f"\n{body}"
    url = f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(url, json={
            "chat_id": cfg["chat_id"],
            "text": text,
            "parse_mode": "HTML",
        })


async def _send_pushover(cfg: dict, title: str, body: str | None) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post("https://api.pushover.net/1/messages.json", data={
            "token":   cfg["app_token"],
            "user":    cfg["user_key"],
            "title":   title,
            "message": body or title,
        })


def _send_smtp_sync(cfg: dict, title: str, body: str | None) -> None:
    msg = MIMEText(body or title)
    msg["Subject"] = title
    msg["From"]    = cfg.get("from_email", cfg.get("username", "metubeplus@localhost"))
    msg["To"]      = cfg["to_email"]

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port", 587))
    use_tls = str(cfg.get("use_tls", "true")).lower() == "true"

    ctx = ssl.create_default_context()
    if use_tls:
        with smtplib.SMTP(host, port) as server:
            server.starttls(context=ctx)
            if cfg.get("username"):
                server.login(cfg["username"], cfg.get("password", ""))
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port) as server:
            if cfg.get("username"):
                server.login(cfg["username"], cfg.get("password", ""))
            server.send_message(msg)


async def _send_smtp(cfg: dict, title: str, body: str | None) -> None:
    await asyncio.to_thread(_send_smtp_sync, cfg, title, body)


_SENDERS = {
    "slack":    _send_slack,
    "discord":  _send_discord,
    "telegram": _send_telegram,
    "pushover": _send_pushover,
    "smtp":     _send_smtp,
}


# ── Public API ────────────────────────────────────────────────────────────────

async def dispatch(kind: str, title: str, body: str | None) -> None:
    """Fire-and-forget dispatcher called from create_notification()."""
    try:
        settings, channels = await asyncio.gather(
            _load_settings(), _load_channels()
        )
    except Exception:
        logger.exception("Failed to load settings/channels for dispatch")
        return

    if _is_suppressed(kind, settings):
        return

    for ch in channels:
        sender = _SENDERS.get(ch["kind"])
        if sender is None:
            continue
        try:
            await sender(ch["config"], title, body)
        except Exception as exc:
            logger.warning("Notification channel %s failed: %s", ch["kind"], exc)


async def send_summary() -> None:
    """Collect unread notifications and dispatch a summary to all enabled channels."""
    from sqlalchemy import select
    from app.models import Notification
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        result = await session.execute(
            select(Notification)
            .where(Notification.is_read == False)  # noqa: E712
            .order_by(Notification.created_at.desc())
            .limit(50)
        )
        notifs = list(result.scalars())

    if not notifs:
        return

    lines = [f"• {n.title}" + (f": {n.body}" if n.body else "") for n in notifs]
    body = "\n".join(lines)
    await dispatch("summary", f"MetubePlus summary — {len(notifs)} notification(s)", body)
