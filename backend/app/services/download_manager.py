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
                await self._update_db(
                    did,
                    status="completed",
                    percent=100.0,
                    output_path=msg.get("output_path"),
                    ext=msg.get("ext"),
                    height=msg.get("height"),
                    filesize=msg.get("filesize"),
                    vcodec=msg.get("vcodec"),
                    acodec=msg.get("acodec"),
                )
                download = await self._get_download(did)
                if download:
                    from app.schemas import DownloadInfo
                    await emit_download_completed(DownloadInfo.model_validate(download).model_dump(mode="json"))
                self._cleanup(did)

            elif msg_type == "error":
                error = msg.get("error", "Unknown error")
                await self._update_db(did, status="failed", error_message=error)
                await emit_download_failed(dataclasses.asdict(DownloadFailedPayload(id=did, error=error)))
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


download_manager = DownloadManager()
