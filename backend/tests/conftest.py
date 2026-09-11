import asyncio

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

        await init_db()
        async with get_sessionmaker()() as session:
            await session.execute(delete(Download))
            await session.commit()

    try:
        asyncio.run(wipe())
    finally:
        _dispose_engine()

    yield

    _dispose_engine()
