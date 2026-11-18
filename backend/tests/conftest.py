import asyncio
import time

import pytest


def _dispose_engine() -> None:
    """Drop the async engine's connection pool.

    The engine is a module singleton, and each test that opens a
    ``TestClient(app)`` runs the FastAPI lifespan in a fresh event loop — a
    connection pooled by an earlier (now-closed) loop breaks the next one. So
    anything that touches the DB in its own loop disposes afterwards.
    """
    async def run() -> None:
        from app.db import engine

        await engine.dispose()

    try:
        asyncio.run(run())
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _clean_db_between_tests():
    """Start every test with an empty ``downloads`` table.

    This is not just tidiness. Rows left behind make the *next* test's lifespan
    call ``resume_incomplete()``, which wakes the queue worker; the worker then
    drains in the background while that test seeds its own rows. SQLite reuses
    row ids after a delete, so the worker can start a job on an id that by then
    belongs to a freshly seeded row — flipping it out of ``queued`` mid-test
    and dropping it from the queue-ordering assertions. Starting empty means
    nothing wakes the worker, and the queue tests stop being flaky.
    """
    async def wipe() -> None:
        from sqlalchemy import delete

        from app.db import get_sessionmaker, init_db
        from app.models import Download

        # Quiesce the queue first. Tests that drive the worker hard (the
        # bot-check ones run with a zero cooldown) can still be mid-write when
        # the next test starts wiping, and SQLite answers a concurrent writer
        # with "database is locked" rather than waiting.
        from app.services.download_manager import download_manager

        try:
            await download_manager.stop()
        except Exception:
            pass

        await init_db()
        async with get_sessionmaker()() as session:
            await session.execute(delete(Download))
            await session.commit()

    # One writer losing a race to another is transient by definition, so retry
    # briefly rather than failing a test for a reason that has nothing to do
    # with what it asserts.
    last: Exception | None = None
    for attempt in range(5):
        try:
            asyncio.run(wipe())
            last = None
            break
        except Exception as exc:  # noqa: BLE001 — retried below, re-raised after
            last = exc
            time.sleep(0.2 * (attempt + 1))
        finally:
            _dispose_engine()
    if last is not None:
        raise last

    yield

    _dispose_engine()
