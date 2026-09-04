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

# Map notification kinds to their suppression setting key.
# Note: create_notification() also gates on these before emitting; this is a
# defense-in-depth check for callers that bypass the in-app Notification row
# and dispatch directly (e.g. send_summary).
_SUPPRESS_KEYS: dict[str, str] = {
    "download_started":    "notify_on_download_start",
    "completed":           "notify_on_complete",
    "failed":              "notify_on_failed",
    "playlist_completed":  "notify_on_playlist_complete",
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

async def _send_slack(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    text = f"*{title}*"
    if body:
        text += f"\n{body}"
    payload: dict = {"text": text}
    # Slack supports image_url on attachments — adds a thumbnail card next to the text.
    if thumbnail:
        payload["attachments"] = [{"image_url": thumbnail, "fallback": title}]
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(cfg["webhook_url"], json=payload)


async def _send_discord(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    content = f"**{title}**"
    if body:
        content += f"\n{body}"
    payload: dict = {"content": content}
    # Discord renders an image embed when given an `embeds[*].image.url`.
    if thumbnail:
        payload["embeds"] = [{"image": {"url": thumbnail}}]
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(cfg["webhook_url"], json=payload)


async def _send_telegram(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    caption = f"<b>{title}</b>"
    if body:
        caption += f"\n{body}"
    base = f"https://api.telegram.org/bot{cfg['bot_token']}"
    async with httpx.AsyncClient(timeout=10) as client:
        if thumbnail:
            # sendPhoto caption has a 1024-char limit; truncate to be safe.
            await client.post(f"{base}/sendPhoto", json={
                "chat_id": cfg["chat_id"],
                "photo": thumbnail,
                "caption": caption[:1024],
                "parse_mode": "HTML",
            })
        else:
            await client.post(f"{base}/sendMessage", json={
                "chat_id": cfg["chat_id"],
                "text": caption,
                "parse_mode": "HTML",
            })


async def _send_pushover(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    # Pushover supports an image attachment via multipart form upload, but
    # the free tier needs the image bytes. To keep this simple and avoid an
    # extra fetch, append the URL to the message instead.
    message = body or title
    if thumbnail:
        message = f"{message}\n{thumbnail}" if message else thumbnail
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post("https://api.pushover.net/1/messages.json", data={
            "token":   cfg["app_token"],
            "user":    cfg["user_key"],
            "title":   title,
            "message": message,
        })


def _send_smtp_sync(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    # Sender — must be a valid address. Fall back to username (usually an email)
    # rather than a synthetic @localhost that most relays reject.
    sender = cfg.get("from_email") or cfg.get("username")
    if not sender:
        raise RuntimeError("SMTP: neither from_email nor username is set")
    to_addr = cfg.get("to_email")
    if not to_addr:
        raise RuntimeError("SMTP: to_email is required")

    # Plain-text fallback + (optional) HTML alternative with thumbnail
    text_body = body or title
    if thumbnail:
        from email.mime.multipart import MIMEMultipart
        html = (
            f"<html><body><h3>{title}</h3>"
            + (f"<p>{(body or '').replace(chr(10), '<br>')}</p>" if body else "")
            + f'<img src="{thumbnail}" alt="" style="max-width:480px;border-radius:8px;">'
            + "</body></html>"
        )
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
    else:
        msg = MIMEText(text_body, _charset="utf-8")
    msg["Subject"] = title
    msg["From"]    = sender
    msg["To"]      = to_addr

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port", 587))
    # Three modes:
    #   "ssl"       → port 465 implicit TLS (SMTP_SSL)
    #   "starttls"  → port 587 explicit upgrade (STARTTLS)
    #   "none"      → plain, no encryption (dev/LAN only)
    # Accept legacy `use_tls` boolean for backward compat:
    #   use_tls=true  → starttls
    #   use_tls=false → none
    mode = str(cfg.get("security") or cfg.get("mode") or "").lower()
    if not mode:
        if "use_tls" in cfg:
            mode = "starttls" if str(cfg["use_tls"]).lower() == "true" else "none"
        else:
            # Auto-detect from port: 465 = implicit SSL, everything else = STARTTLS
            mode = "ssl" if port == 465 else "starttls"

    username = cfg.get("username")
    password = cfg.get("password", "")

    ctx = ssl.create_default_context()
    if mode == "ssl":
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as server:
            if username:
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])
    elif mode == "starttls":
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.ehlo()
            server.starttls(context=ctx)
            server.ehlo()
            if username:
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])
    else:  # none
        with smtplib.SMTP(host, port, timeout=30) as server:
            if username:
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])


async def _send_smtp(cfg: dict, title: str, body: str | None, thumbnail: str | None) -> None:
    await asyncio.to_thread(_send_smtp_sync, cfg, title, body, thumbnail)


_SENDERS = {
    "slack":    _send_slack,
    "discord":  _send_discord,
    "telegram": _send_telegram,
    "pushover": _send_pushover,
    "smtp":     _send_smtp,
}


# ── Public API ────────────────────────────────────────────────────────────────

async def dispatch(kind: str, title: str, body: str | None, thumbnail: str | None = None) -> None:
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
            await sender(ch["config"], title, body, thumbnail)
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
    await dispatch("summary", f"StreamSnap summary — {len(notifs)} notification(s)", body, None)
