from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(settings.DB_URL, echo=settings.DEBUG)

_SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with _SessionLocal() as session:
        yield session


async def init_db() -> None:
    # Import models so their metadata is registered before create_all
    import app.models  # noqa: F401
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # ── Lightweight migrations for existing SQLite DBs ──────────────────
        # create_all() won't add columns to tables that already exist, so we
        # additively ALTER where needed. Each block is idempotent.
        def _existing_cols(sync_conn, table: str) -> set[str]:
            rows = sync_conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            return {r[1] for r in rows}

        subs_cols = await conn.run_sync(lambda c: _existing_cols(c, "subscriptions"))
        if "notify" not in subs_cols:
            await conn.execute(
                text("ALTER TABLE subscriptions ADD COLUMN notify BOOLEAN DEFAULT 1")
            )

        notif_cols = await conn.run_sync(lambda c: _existing_cols(c, "notifications"))
        if "thumbnail" not in notif_cols:
            await conn.execute(
                text("ALTER TABLE notifications ADD COLUMN thumbnail VARCHAR")
            )

        # Category / subcategory / tag — added together so a single migration
        # block covers any DB created before the feature shipped. We also
        # carry over any pre-existing `media_category` column from earlier
        # beta builds; the new schema replaces it (data isn't migrated since
        # beta was not yet released).
        dl_cols = await conn.run_sync(lambda c: _existing_cols(c, "downloads"))
        for col in ("category", "subcategory", "tag"):
            if col not in dl_cols:
                await conn.execute(
                    text(f"ALTER TABLE downloads ADD COLUMN {col} VARCHAR")
                )

        for col in ("category", "subcategory", "tag"):
            if col not in subs_cols:
                await conn.execute(
                    text(f"ALTER TABLE subscriptions ADD COLUMN {col} VARCHAR")
                )

        # If a pre-release beta DB has the old single-level `media_category`
        # column populated, copy those values into the new `category` column
        # the first time the new schema runs. We don't drop the old column
        # because SQLite needs a table rebuild for that — leaving it as
        # dead weight is harmless and lets users roll back if needed.
        dl_cols_after = await conn.run_sync(lambda c: _existing_cols(c, "downloads"))
        if "media_category" in dl_cols_after and "category" in dl_cols_after:
            await conn.execute(
                text(
                    "UPDATE downloads SET category = media_category "
                    "WHERE category IS NULL AND media_category IS NOT NULL"
                )
            )


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Returns the session factory for use outside of route dependencies."""
    return _SessionLocal
