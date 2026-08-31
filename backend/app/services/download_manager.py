"""
Download Manager — orchestrates concurrent downloads using ThreadPoolExecutor.

Using threads (not processes) because yt-dlp downloads are I/O-bound
(network + disk), so the GIL is not a bottleneck. This avoids multiprocessing
complexity (Manager, pickling, Windows spawn issues) entirely.

Architecture:
  - _process_queue(): asyncio task that dequeues jobs and submits to executor
  - _relay_progress(): asyncio task that reads from queue.Queue and emits WS events
  - Each download gets a threading.Event for cancellation, checked by the progress hook
"""

import asyncio
import dataclasses
import queue
import threading
from concurrent.futures import Future, ThreadPoolExecutor

from app.config import settings
from app.db import get_sessionmaker
from app.events import DownloadCanceledPayload, DownloadFailedPayload, DownloadUpdatedPayload
from app.ws import (
    emit_download_canceled,
    emit_download_completed,
    emit_download_failed,
    emit_download_updated,
    emit_downloads_paused,
)
from app.ytdl.service import run_download


# Error substrings that mean "YouTube wants authentication" — not a real
# per-video failure, and hammering it makes the block worse. When we see one
# we stop the whole queue and alert the user.
_BOT_CHECK_MARKERS = (
    "confirm you’re not a bot",
    "confirm you're not a bot",
    "sign in to confirm you",
    "--cookies-from-browser",
)


def _is_bot_check(message: str) -> bool:
    m = (message or "").lower()
    return any(marker in m for marker in _BOT_CHECK_MARKERS)


# Thread-pool ceiling. Actual parallelism is gated separately by
# DownloadManager._concurrency (the "max_concurrent_downloads" setting), so this
# only needs to be a sane upper bound.
_EXECUTOR_MAX_WORKERS = 16
_CONCURRENCY_MIN = 1
_CONCURRENCY_MAX = 12


@dataclasses.dataclass
class _Job:
    download_id: int
    url: str
    format_spec: str
    output_dir: str | None = None  # None → use settings.DOWNLOAD_DIR


class DownloadManager:
    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._job_queue: asyncio.Queue[_Job] = asyncio.Queue()
        self._progress_queue: queue.Queue = queue.Queue()
        self._active_futures: dict[int, Future] = {}
        self._cancel_events: dict[int, threading.Event] = {}
        self._worker_task: asyncio.Task | None = None
        self._relay_task: asyncio.Task | None = None

        # Pause state. The worker loop blocks on _resume_event while paused.
        self._paused: bool = False
        self._pause_reason: str | None = None
        self._resume_event: asyncio.Event = asyncio.Event()
        self._resume_event.set()
        # Downloads we cancelled as part of pause() — their cancellation should
        # land them back in "queued", not "canceled".
        self._paused_ids: set[int] = set()

        # Live concurrency limit (the "max_concurrent_downloads" setting).
        self._concurrency: int = _CONCURRENCY_MIN
        self._running: int = 0
        self._counted_ids: set[int] = set()  # downloads currently holding a slot
        self._slot_free: asyncio.Event = asyncio.Event()
        self._slot_free.set()

    async def start(self) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=_EXECUTOR_MAX_WORKERS,
            thread_name_prefix="ytdl-worker",
        )
        self._paused = False
        self._pause_reason = None
        self._resume_event.set()
        self._running = 0
        self._counted_ids.clear()
        self._slot_free.set()
        self._concurrency = await self._effective_concurrency()
        self._worker_task = asyncio.create_task(self._process_queue())
        self._relay_task = asyncio.create_task(self._relay_progress())

    async def _effective_concurrency(self) -> int:
        """Read max_concurrent_downloads from settings; default 1 when unset."""
        from app.models import Setting

        SessionLocal = get_sessionmaker()
        async with SessionLocal() as session:
            row = await session.get(Setting, "max_concurrent_downloads")
        raw = row.value if row and row.value else None
        try:
            n = int(raw) if raw is not None else _CONCURRENCY_MIN
        except (TypeError, ValueError):
            n = _CONCURRENCY_MIN
        return max(_CONCURRENCY_MIN, min(_CONCURRENCY_MAX, n))

    async def set_concurrency(self, n: int) -> int:
        """Change how many downloads run at once, effective immediately."""
        self._concurrency = max(_CONCURRENCY_MIN, min(_CONCURRENCY_MAX, int(n)))
        self._slot_free.set()  # wake the worker if we just raised the limit
        return self._concurrency

    @property
    def status(self) -> dict:
        return {
            "paused": self._paused,
            "reason": self._pause_reason,
            "active": len(self._active_futures),
            "max_concurrent": self._concurrency,
        }

    async def pause(self, reason: str) -> None:
        """Stop starting new downloads and cancel the ones in flight.

        Cancelled downloads go back to "queued" so a later resume re-runs them
        (yt-dlp continues from the .part file).
        """
        if self._paused:
            return
        self._paused = True
        self._pause_reason = reason
        self._resume_event.clear()

        # Drop everything still waiting — resume() rebuilds the queue from the
        # DB (all these rows are still "queued"), so nothing is lost.
        while not self._job_queue.empty():
            try:
                self._job_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        for did, future in list(self._active_futures.items()):
            self._paused_ids.add(did)
            ev = self._cancel_events.get(did)
            if ev is not None:
                ev.set()
            future.cancel()

        await emit_downloads_paused({"paused": True, "reason": reason})

    async def resume(self) -> None:
        if not self._paused and self._resume_event.is_set():
            return
        self._paused = False
        self._pause_reason = None
        self._resume_event.set()
        # _paused_ids is left to drain as the cancelled downloads' final
        # messages arrive (handled in _relay_progress).
        await emit_downloads_paused({"paused": False, "reason": None})

    async def stop(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
        if self._relay_task:
            self._relay_task.cancel()
        if self._executor:
            self._executor.shutdown(wait=False, cancel_futures=True)

    async def enqueue(
        self,
        download_id: int,
        url: str,
        format_spec: str,
        output_dir: str | None = None,
    ) -> None:
        await self._job_queue.put(
            _Job(download_id=download_id, url=url, format_spec=format_spec, output_dir=output_dir)
        )

    async def resume_incomplete(self) -> int:
        """Re-enqueue downloads left as queued/downloading by a restart.

        The in-memory queue and worker futures don't survive a process
        restart, so these rows would otherwise sit frozen forever. yt-dlp
        resumes from the partial ``.part`` file (continuedl, on by default),
        so little or no progress is lost. Returns how many were re-enqueued.

        Also lifts a pause — this is the "Resume" action.
        """
        import os

        from sqlalchemy import and_, or_, select
        from app.models import Download, Subscription

        await self.resume()

        SessionLocal = get_sessionmaker()
        jobs: list[tuple[int, str, str, str | None]] = []
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    select(Download)
                    .where(
                        or_(
                            Download.status.in_(("queued", "downloading")),
                            # failures from a YouTube bot check aren't real
                            # failures — bring them back too.
                            and_(
                                Download.status == "failed",
                                Download.error_message.ilike("%not a bot%"),
                            ),
                        )
                    )
                    .order_by(Download.created_at.asc())
                )
            ).scalars().all()

            for d in rows:
                # Skip anything actually running right now (manual re-run while
                # some downloads are live) — don't double-enqueue it.
                if d.id in self._active_futures:
                    continue

                output_dir: str | None = None
                if d.subscription_id is not None:
                    sub = await session.get(Subscription, d.subscription_id)
                    if sub is not None:
                        output_dir = sub.download_dir
                if output_dir is None and d.output_path:
                    output_dir = os.path.dirname(d.output_path) or None

                d.status = "queued"
                d.speed = None
                d.eta = None
                jobs.append(
                    (d.id, d.url, d.format_spec or "bestvideo*+bestaudio/best", output_dir)
                )
            await session.commit()

        for did, url, fmt, out in jobs:
            await emit_download_updated(
                {"id": did, "status": "queued", "speed": None, "eta": None}
            )
            await self.enqueue(did, url, fmt, out)
        return len(jobs)

    async def cancel(self, download_id: int) -> bool:
        event = self._cancel_events.get(download_id)
        if event is not None:
            event.set()

        future = self._active_futures.get(download_id)
        if future is not None:
            future.cancel()
            return True
        return False

    # ── Internal tasks ────────────────────────────────────────────────────────

    async def _load_app_settings(self) -> dict:
        """Load all Setting rows as a plain {key: value} dict."""
        from sqlalchemy import select
        from app.models import Setting
        SessionLocal = get_sessionmaker()
        async with SessionLocal() as session:
            result = await session.execute(select(Setting))
            return {s.key: s.value for s in result.scalars()}

    async def _process_queue(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await self._resume_event.wait()  # block here while paused

            # Wait for a concurrency slot to free up.
            while self._running >= self._concurrency:
                self._slot_free.clear()
                await self._slot_free.wait()
                await self._resume_event.wait()

            job = await self._job_queue.get()
            if self._paused:
                # Pause landed while this job was in flight — drop it; the row
                # is still "queued" and resume() re-enqueues it from the DB.
                continue
            cancel_event = threading.Event()
            self._cancel_events[job.download_id] = cancel_event

            await self._update_db(job.download_id, status="downloading")
            await self._notify_started(job.download_id)

            app_settings = await self._load_app_settings()

            self._running += 1
            self._counted_ids.add(job.download_id)
            future: Future = self._executor.submit(
                run_download,
                job.download_id,
                job.url,
                job.format_spec,
                job.output_dir or settings.DOWNLOAD_DIR,
                self._progress_queue,
                cancel_event,
                app_settings,
            )
            self._active_futures[job.download_id] = future

            def _on_done(f: Future, did: int = job.download_id) -> None:
                if f.cancelled():
                    self._progress_queue.put({"type": "canceled", "id": did, "error": "Canceled"})
                elif f.exception() is not None:
                    self._progress_queue.put({"type": "error", "id": did, "error": str(f.exception())})
                # "finished" type is already put by the progress hook

            future.add_done_callback(_on_done)

    async def _relay_progress(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                msg = await loop.run_in_executor(None, self._blocking_get)
            except Exception:
                await asyncio.sleep(0.1)
                continue

            if msg is None:
                continue

            msg_type = msg.get("type")
            did = msg.get("id")

            if msg_type == "progress":
                await self._update_db(
                    did,
                    percent=msg["percent"],
                    speed=msg.get("speed"),
                    eta=msg.get("eta"),
                    status="downloading",
                )
                await emit_download_updated(dataclasses.asdict(
                    DownloadUpdatedPayload(
                        id=did,
                        percent=msg["percent"],
                        speed=msg.get("speed"),
                        eta=msg.get("eta"),
                        status="downloading",
                    )
                ))

            elif msg_type == "finished":
                # Only set title/thumbnail/duration when the row didn't
                # already have them — preserves frontend-provided values
                # (e.g. one-off download where the user resolved metadata up
                # front) over the post-merge yt-dlp values.
                fin_kwargs: dict = {
                    "status": "completed",
                    "percent": 100.0,
                    "output_path": msg.get("output_path"),
                    "ext": msg.get("ext"),
                    "height": msg.get("height"),
                    "filesize": msg.get("filesize"),
                    "vcodec": msg.get("vcodec"),
                    "acodec": msg.get("acodec"),
                }
                existing = await self._get_download(did)
                if existing is not None:
                    if not existing.thumbnail and msg.get("thumbnail"):
                        fin_kwargs["thumbnail"] = msg["thumbnail"]
                    if not existing.title and msg.get("title"):
                        fin_kwargs["title"] = msg["title"]
                    if not existing.duration and msg.get("duration"):
                        fin_kwargs["duration"] = msg["duration"]
                await self._update_db(did, **fin_kwargs)
                download = await self._get_download(did)
                if download:
                    from app.schemas import DownloadInfo
                    await emit_download_completed(
                        DownloadInfo.model_validate(download).model_dump(mode="json")
                    )
                    await self._notify_completion(download, success=True)
                self._cleanup(did)

            elif msg_type == "error":
                error = msg.get("error", "Unknown error")

                # Errored because pause() cancelled it → requeue, don't fail.
                if did in self._paused_ids:
                    self._paused_ids.discard(did)
                    await self._update_db(did, status="queued", speed=None, eta=None)
                    await emit_download_updated(
                        {"id": did, "status": "queued", "speed": None, "eta": None}
                    )
                    self._cleanup(did)
                    continue

                # YouTube auth wall — not a real failure. Put the row back to
                # "queued", pause everything, and alert the user once.
                if _is_bot_check(error):
                    await self._update_db(
                        did, status="queued", speed=None, eta=None, error_message=None
                    )
                    await emit_download_updated(
                        {"id": did, "status": "queued", "speed": None, "eta": None}
                    )
                    self._cleanup(did)
                    if not self._paused:
                        await self._trigger_bot_check_pause(did)
                    continue

                await self._update_db(did, status="failed", error_message=error)
                await emit_download_failed(dataclasses.asdict(DownloadFailedPayload(id=did, error=error)))
                download = await self._get_download(did)
                if download:
                    await self._notify_completion(download, success=False, error=error)
                self._cleanup(did)

            elif msg_type == "canceled":
                # A cancel that's part of pause() → back to the queue, not "canceled".
                if did in self._paused_ids:
                    self._paused_ids.discard(did)
                    await self._update_db(did, status="queued", speed=None, eta=None)
                    await emit_download_updated(
                        {"id": did, "status": "queued", "speed": None, "eta": None}
                    )
                else:
                    await self._update_db(did, status="canceled")
                    await emit_download_canceled(dataclasses.asdict(DownloadCanceledPayload(id=did)))
                self._cleanup(did)

    async def _trigger_bot_check_pause(self, download_id: int) -> None:
        from app.services.notifications import create_notification

        reason = (
            "YouTube is asking MetubePlus to confirm it's not a bot. "
            "Add cookies in Settings → Auth, then resume."
        )
        await self.pause(reason)

        download = await self._get_download(download_id)
        what = (download.title or download.url) if download else f"download #{download_id}"
        await create_notification(
            kind="auth_required",
            title="Downloads paused — YouTube sign-in required",
            body=(
                "YouTube blocked a download with “Sign in to confirm you’re "
                "not a bot”, so all downloads have been paused.\n\n"
                f"First hit: {what}\n\n"
                "Fix: Settings → Auth → set cookies-from-browser (or upload a "
                "cookies file), then click Resume downloads."
            ),
        )

    def _blocking_get(self) -> dict | None:
        try:
            return self._progress_queue.get(timeout=0.5)
        except queue.Empty:
            return None

    def _cleanup(self, download_id: int) -> None:
        self._active_futures.pop(download_id, None)
        self._cancel_events.pop(download_id, None)
        if download_id in self._counted_ids:
            self._counted_ids.discard(download_id)
            self._running = max(0, self._running - 1)
            self._slot_free.set()

    async def _update_db(self, download_id: int, **kwargs) -> None:
        from datetime import datetime
        from app.models import Download

        SessionLocal = get_sessionmaker()
        async with SessionLocal() as session:
            download = await session.get(Download, download_id)
            if download is None:
                return
            for key, value in kwargs.items():
                setattr(download, key, value)
            download.updated_at = datetime.utcnow()
            await session.commit()

    async def _get_download(self, download_id: int) -> object | None:
        from app.models import Download

        SessionLocal = get_sessionmaker()
        async with SessionLocal() as session:
            return await session.get(Download, download_id)

    async def _notify_started(self, download_id: int) -> None:
        """Fire a download_started notification.

        For subscription downloads we skip — the playlist summary covers it,
        and emitting per-video starts would just resurrect the toast spam
        that the kind-level gate is meant to prevent.
        """
        from app.services.notifications import create_notification

        download = await self._get_download(download_id)
        if download is None or download.subscription_id is not None:
            return
        title_txt = download.title or download.url
        await create_notification(
            kind="download_started",
            title=f"Download started: {title_txt}",
            body=None,
            thumbnail=download.thumbnail,
            payload={"download_id": download.id},
        )

    async def _notify_completion(self, download, success: bool, error: str | None = None) -> None:
        """
        Create a Notification row for a completed/failed download.

        For subscription-driven downloads we deliberately skip per-video
        notifications (they spam when a long playlist polls in N new videos)
        and emit a single `playlist_completed` summary once the whole batch
        finishes. One-off (non-subscription) downloads still get an individual
        `completed`/`failed` notification.
        """
        from sqlalchemy import and_, select
        from app.models import Download, Subscription
        from app.services.notifications import create_notification

        sub_id = download.subscription_id
        sub_title: str | None = None
        sub_notify_enabled = True

        if sub_id is not None:
            SessionLocal = get_sessionmaker()
            async with SessionLocal() as session:
                sub = await session.get(Subscription, sub_id)
                if sub is not None:
                    sub_title = sub.title
                    sub_notify_enabled = sub.notify

        title_txt = download.title or download.url

        # 1. Individual-file notification — only for one-off downloads.
        # Subscription downloads always roll up into the playlist summary.
        if sub_id is None:
            if success:
                await create_notification(
                    kind="completed",
                    title=f"Download completed: {title_txt}",
                    body=download.output_path or None,
                    thumbnail=download.thumbnail,
                    payload={"download_id": download.id},
                )
            else:
                await create_notification(
                    kind="failed",
                    title=f"Download failed: {title_txt}",
                    body=error,
                    thumbnail=download.thumbnail,
                    payload={"download_id": download.id},
                )
            return

        # 2. Playlist summary — only when the whole batch finished
        if not sub_notify_enabled:
            return

        SessionLocal = get_sessionmaker()
        async with SessionLocal() as session:
            pending = await session.execute(
                select(Download).where(
                    and_(
                        Download.subscription_id == sub_id,
                        Download.status.in_(("queued", "downloading")),
                    )
                )
            )
            if pending.scalars().first() is not None:
                return  # more siblings still in-flight — wait for them

            result = await session.execute(
                select(Download)
                .where(Download.subscription_id == sub_id)
                .order_by(Download.updated_at.desc())
                .limit(50)
            )
            siblings = list(result.scalars())

        if not siblings:
            return

        done = [d for d in siblings if d.status == "completed"]
        failed = [d for d in siblings if d.status == "failed"]
        if not done and not failed:
            return

        label = sub_title or f"subscription #{sub_id}"
        summary_title = f"Playlist complete: {label} — {len(done)} done, {len(failed)} failed"
        lines = []
        for d in done[:20]:
            lines.append(f"✓ {d.title or d.url}")
        for d in failed[:10]:
            lines.append(f"✕ {d.title or d.url}: {d.error_message or 'failed'}")

        # Use the most recent successful sibling's thumbnail as the summary art.
        summary_thumb = next((d.thumbnail for d in done if d.thumbnail), None) \
            or next((d.thumbnail for d in siblings if d.thumbnail), None)

        await create_notification(
            kind="playlist_completed",
            title=summary_title,
            body="\n".join(lines) if lines else None,
            thumbnail=summary_thumb,
            payload={"subscription_id": sub_id, "done": len(done), "failed": len(failed)},
        )


download_manager = DownloadManager()
