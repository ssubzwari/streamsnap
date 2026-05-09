from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(settings.DB_URL, echo=settings.DEBUG)

_SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

# Bump this constant whenever a new _migrate_vN function is added.
# Format: integer, monotonically increasing.
SCHEMA_VERSION = 1


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with _SessionLocal() as session:
        yield session


# ── Migration helpers ─────────────────────────────────────────────────────────

def _existing_cols(sync_conn, table: str) -> set[str]:
    rows = sync_conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return {r[1] for r in rows}


async def _migrate_v1(conn: AsyncConnection) -> None:
    """Formalise all pre-versioning schema changes.

    On a brand-new DB these columns don't exist yet and must be added.
    On an existing DB that was already running before version tracking was
    introduced, this function is never called — the bootstrap logic in
    init_db() detects existing user data and sets stored_version = 1 directly.
    """
    from sqlalchemy import text

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

    dl_cols = await conn.run_sync(lambda c: _existing_cols(c, "downloads"))
    for col in ("category", "subcategory", "tag"):
        if col not in dl_cols:
            await conn.execute(
                text(f"ALTER TABLE downloads ADD COLUMN {col} VARCHAR")
            )

    subs_cols2 = await conn.run_sync(lambda c: _existing_cols(c, "subscriptions"))
    for col in ("category", "subcategory", "tag"):
        if col not in subs_cols2:
            await conn.execute(
                text(f"ALTER TABLE subscriptions ADD COLUMN {col} VARCHAR")
            )

    # Copy any pre-release beta `media_category` values into the new `category`
    # column. The old column is left in place (SQLite can't drop columns without
    # a table rebuild) — it becomes inert dead weight.
    dl_cols_after = await conn.run_sync(lambda c: _existing_cols(c, "downloads"))
    if "media_category" in dl_cols_after and "category" in dl_cols_after:
        await conn.execute(
            text(
                "UPDATE downloads SET category = media_category "
                "WHERE category IS NULL AND media_category IS NOT NULL"
            )
        )


# Registry — index N-1 contains the function that migrates to version N.
# To add version 2: write _migrate_v2, append it here, set SCHEMA_VERSION = 2.
_MIGRATIONS = [
    _migrate_v1,   # index 0 → reaches version 1
]


# ── Database initialisation ───────────────────────────────────────────────────

async def init_db() -> None:
    # Import models so their metadata is registered before create_all.
    import app.models  # noqa: F401
    from sqlalchemy import text

    async with engine.begin() as conn:
        # Create any missing tables (idempotent).
        await conn.run_sync(Base.metadata.create_all)

        # ── Determine the stored schema version ───────────────────────────────
        version_row = (await conn.execute(
            text("SELECT value FROM settings WHERE key = 'schema_version'")
        )).fetchone()

        if version_row is None:
            # No version row yet. Distinguish new DB from existing DB:
            # an existing DB will have other settings rows (user config).
            other_rows = (await conn.execute(
                text("SELECT COUNT(*) FROM settings WHERE key != 'schema_version'")
            )).scalar()

            if other_rows and other_rows > 0:
                # Existing install predating version tracking — all current
                # migrations are already applied, so start at version 1.
                stored_version = 1
            else:
                # Brand-new database — run every migration from scratch.
                stored_version = 0

            await conn.execute(
                text("INSERT INTO settings(key, value) VALUES ('schema_version', :v)"),
                {"v": str(stored_version)},
            )
        else:
            stored_version = int(version_row[0])

        # ── Run pending migrations ────────────────────────────────────────────
        for target in range(stored_version + 1, SCHEMA_VERSION + 1):
            await _MIGRATIONS[target - 1](conn)
            # Write the version after each successful migration so a crash
            # mid-run leaves the DB at the last completed version, not at 0.
            await conn.execute(
                text("UPDATE settings SET value = :v WHERE key = 'schema_version'"),
                {"v": str(target)},
            )


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Returns the session factory for use outside of route dependencies."""
    return _SessionLocal
