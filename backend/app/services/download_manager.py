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
)
from app.ytdl.service import run_download


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

    async def start(self) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=settings.MAX_CONCURRENT_DOWNLOADS,
            thread_name_prefix="ytdl-worker",
        )
        self._worker_task = asyncio.create_task(self._process_queue())
        self._relay_task = asyncio.create_task(self._relay_progress())

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
        """
        import os

        from sqlalchemy import select
        from app.models import Download, Subscription

        SessionLocal = get_sessionmaker()
        jobs: list[tuple[int, str, str, str | None]] = []
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    select(Download)
                    .where(Download.status.in_(("queued", "downloading")))
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
            job = await self._job_queue.get()
            cancel_event = threading.Event()
            self._cancel_events[job.download_id] = cancel_event

            await self._update_db(job.download_id, status="downloading")
            await self._notify_started(job.download_id)

            app_settings = await self._load_app_settings()

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
                await self._update_db(did, status="failed", error_message=error)
                await emit_download_failed(dataclasses.asdict(DownloadFailedPayload(id=did, error=error)))
                download = await self._get_download(did)
                if download:
                    await self._notify_completion(download, success=False, error=error)
                self._cleanup(did)

            elif msg_type == "canceled":
                await self._update_db(did, status="canceled")
                await emit_download_canceled(dataclasses.asdict(DownloadCanceledPayload(id=did)))
                self._cleanup(did)

    def _blocking_get(self) -> dict | None:
        try:
            return self._progress_queue.get(timeout=0.5)
        except queue.Empty:
            return None

    def _cleanup(self, download_id: int) -> None:
        self._active_futures.pop(download_id, None)
        self._cancel_events.pop(download_id, None)

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
