"""
External notification dispatcher.

Called by create_notification() after the DB record is created and the
WebSocket event is emitted.  Loads all enabled NotificationChannel rows,
checks suppression settings, then dispatches to each channel asynchronously.
"""

import asyncio
import json
import logging
import re
import smtplib
import ssl
import time
from email.mime.text import MIMEText
from typing import Callable

import httpx

from app.db import get_sessionmaker

logger = logging.getLogger(__name__)

# A sink senders push human-readable progress lines to. Defaults to a no-op so
# the normal dispatch path stays quiet; the "Test channel" flow passes a list
# collector so the UI can show a step-by-step debug log.
LogFn = Callable[[str], None]


def _noop(_msg: str) -> None:
    pass


_SECRET_RE = [
    (re.compile(r"bot\d{5,}:[A-Za-z0-9_-]+"), "bot<token>"),
    (re.compile(r"(hooks\.slack\.com/services/)[A-Za-z0-9/+_-]+"), r"\1<redacted>"),
    (re.compile(r"(discord(?:app)?\.com/api/webhooks/)[0-9]+/[A-Za-z0-9._-]+"), r"\1<redacted>"),
]


def _redact(text: str) -> str:
    """Strip webhook secrets / bot tokens out of a string bound for the UI."""
    for pattern, repl in _SECRET_RE:
        text = pattern.sub(repl, text)
    return text


async def _post_and_check(
    log: LogFn, url: str, *, payload: dict | None = None, data: dict | None = None
) -> None:
    """POST helper shared by the webhook senders — logs the round-trip and
    raises on any non-2xx so failures surface instead of passing silently."""
    log(f"POST {_redact(url.split('?')[0])}")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(url, json=payload, data=data)
    log(f"← HTTP {resp.status_code} {resp.reason_phrase}")
    if resp.status_code >= 400:
        snippet = _redact(resp.text.strip())[:300]
        if snippet:
            log(f"← {snippet}")
        raise RuntimeError(f"HTTP {resp.status_code} from {resp.request.url.host}")

# The notification kinds a channel can be subscribed to, in UI order.
# `summary` is the periodic digest; the rest map 1:1 to notification kinds.
CHANNEL_EVENT_KINDS: tuple[str, ...] = (
    "download_started",
    "completed",
    "failed",
    "playlist_completed",
    "new_video",
    "subscription_error",
    "summary",
)

# Applied when a channel's events_json is NULL — matches the pre-per-channel
# behaviour (everything that was on by default, plus the periodic summary).
DEFAULT_CHANNEL_EVENTS: tuple[str, ...] = (
    "completed",
    "failed",
    "playlist_completed",
    "subscription_error",
    "summary",
)

# Kinds that always go out to every enabled channel regardless of its filter —
# operational alerts the user can't afford to silently miss.
_ALWAYS_SEND: frozenset[str] = frozenset({"auth_required"})


def _channel_wants(kind: str, events: list[str] | None) -> bool:
    if kind in _ALWAYS_SEND:
        return True
    allowed = events if events is not None else DEFAULT_CHANNEL_EVENTS
    return kind in allowed


async def _load_channels() -> list[dict]:
    from sqlalchemy import select
    from app.models import NotificationChannel
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as session:
        result = await session.execute(
            select(NotificationChannel).where(NotificationChannel.is_enabled == True)  # noqa: E712
        )
        channels = []
        for c in result.scalars():
            try:
                events = json.loads(c.events_json) if c.events_json else None
            except (ValueError, TypeError):
                events = None
            if events is not None and not isinstance(events, list):
                events = None
            channels.append({
                "kind": c.kind,
                "config": json.loads(c.config_json or "{}"),
                "events": events,
            })
        return channels


# ── Per-channel senders ───────────────────────────────────────────────────────

async def _send_slack(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
    if not cfg.get("webhook_url"):
        raise RuntimeError("Slack: webhook_url is required")
    text = f"*{title}*"
    if body:
        text += f"\n{body}"
    payload: dict = {"text": text}
    # Slack supports image_url on attachments — adds a thumbnail card next to the text.
    if thumbnail:
        payload["attachments"] = [{"image_url": thumbnail, "fallback": title}]
    await _post_and_check(log, cfg["webhook_url"], payload=payload)


async def _send_discord(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
    if not cfg.get("webhook_url"):
        raise RuntimeError("Discord: webhook_url is required")
    content = f"**{title}**"
    if body:
        content += f"\n{body}"
    payload: dict = {"content": content}
    # Discord renders an image embed when given an `embeds[*].image.url`.
    if thumbnail:
        payload["embeds"] = [{"image": {"url": thumbnail}}]
    await _post_and_check(log, cfg["webhook_url"], payload=payload)


async def _send_telegram(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
    if not cfg.get("bot_token") or not cfg.get("chat_id"):
        raise RuntimeError("Telegram: bot_token and chat_id are required")
    caption = f"<b>{title}</b>"
    if body:
        caption += f"\n{body}"
    base = f"https://api.telegram.org/bot{cfg['bot_token']}"
    log(f"chat_id={cfg['chat_id']}")
    if thumbnail:
        # sendPhoto caption has a 1024-char limit; truncate to be safe.
        await _post_and_check(log, f"{base}/sendPhoto", payload={
            "chat_id": cfg["chat_id"],
            "photo": thumbnail,
            "caption": caption[:1024],
            "parse_mode": "HTML",
        })
    else:
        await _post_and_check(log, f"{base}/sendMessage", payload={
            "chat_id": cfg["chat_id"],
            "text": caption,
            "parse_mode": "HTML",
        })


async def _send_pushover(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
    if not cfg.get("app_token") or not cfg.get("user_key"):
        raise RuntimeError("Pushover: app_token and user_key are required")
    # Pushover supports an image attachment via multipart form upload, but
    # the free tier needs the image bytes. To keep this simple and avoid an
    # extra fetch, append the URL to the message instead.
    message = body or title
    if thumbnail:
        message = f"{message}\n{thumbnail}" if message else thumbnail
    await _post_and_check(log, "https://api.pushover.net/1/messages.json", data={
        "token":   cfg["app_token"],
        "user":    cfg["user_key"],
        "title":   title,
        "message": message,
    })


def _send_smtp_sync(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
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

    log(f"Connecting to {host}:{port} (mode={mode})")
    log(f"From {sender} → {to_addr}")

    ctx = ssl.create_default_context()
    if mode == "ssl":
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as server:
            log("TLS connection established (implicit SSL)")
            if username:
                log(f"Authenticating as {username}")
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])
    elif mode == "starttls":
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.ehlo()
            server.starttls(context=ctx)
            log("STARTTLS negotiated")
            server.ehlo()
            if username:
                log(f"Authenticating as {username}")
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])
    else:  # none
        with smtplib.SMTP(host, port, timeout=30) as server:
            log("Connected (no encryption)")
            if username:
                log(f"Authenticating as {username}")
                server.login(username, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to_addr])
    log("Message accepted by server")


async def _send_smtp(
    cfg: dict, title: str, body: str | None, thumbnail: str | None, log: LogFn = _noop
) -> None:
    await asyncio.to_thread(_send_smtp_sync, cfg, title, body, thumbnail, log)


_SENDERS = {
    "slack":    _send_slack,
    "discord":  _send_discord,
    "telegram": _send_telegram,
    "pushover": _send_pushover,
    "smtp":     _send_smtp,
}


# ── Public API ────────────────────────────────────────────────────────────────

async def run_channel_test(kind: str, cfg: dict) -> dict:
    """Send a test notification through one channel, capturing a step-by-step
    log. Never raises — returns ``{"ok": bool, "logs": [str], "error": str|None}``
    so the UI can render a debug panel on both success and failure."""
    logs: list[str] = []

    def log(msg: str) -> None:
        logs.append(_redact(str(msg)))

    sender = _SENDERS.get(kind)
    if sender is None:
        return {"ok": False, "logs": [f"Unknown channel kind: {kind}"],
                "error": f"Unknown channel kind: {kind}"}

    provided = sorted(k for k, v in cfg.items() if str(v).strip())
    log(f"Channel: {kind}")
    log(f"Config provided: {', '.join(provided) or '(none)'}")

    started = time.perf_counter()
    try:
        await sender(cfg, "StreamSnap test notification",
                     "If you can see this, the channel is configured correctly.",
                     None, log)
        log(f"OK — delivered in {(time.perf_counter() - started) * 1000:.0f} ms")
        return {"ok": True, "logs": logs, "error": None}
    except Exception as exc:  # noqa: BLE001 — every failure mode goes to the UI
        detail = f"{type(exc).__name__}: {exc}"
        log(f"FAILED after {(time.perf_counter() - started) * 1000:.0f} ms")
        log(detail)
        return {"ok": False, "logs": logs, "error": str(exc) or detail}


async def dispatch(kind: str, title: str, body: str | None, thumbnail: str | None = None) -> None:
    """Fire-and-forget dispatcher called from create_notification() and
    send_summary(). Each enabled channel receives the event only if it is in
    that channel's own event filter (or the default set when unset).

    The in-app toast gate lives in create_notification(); channels are
    independent of it so e.g. a channel can carry only the periodic summary.
    """
    try:
        channels = await _load_channels()
    except Exception:
        logger.exception("Failed to load channels for dispatch")
        return

    for ch in channels:
        if not _channel_wants(kind, ch["events"]):
            continue
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
