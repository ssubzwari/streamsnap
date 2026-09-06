import asyncio

import pytest


@pytest.fixture(autouse=True)
def _dispose_engine_between_tests():
    """The async SQLAlchemy engine is a module singleton. Each test that opens
    a `TestClient(app)` runs the FastAPI lifespan in a fresh event loop, and a
    connection pooled by an earlier (now-closed) loop breaks the next one.
    Dropping the pool after every test keeps them independent.
    """
    yield
    from app.db import engine

    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
