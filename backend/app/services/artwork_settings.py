"""Resolved artwork settings.

The Settings row wins, the ``.env`` value backs it up — the same precedence
used everywhere else the UI can override a config default.
"""

from app.config import settings


async def get_setting(key: str, default: str = "") -> str:
    from app.db import get_sessionmaker
    from app.models import Setting

    async with get_sessionmaker()() as s:
        row = await s.get(Setting, key)
    value = row.value if row and row.value is not None else None
    return value if value not in (None, "") else default


async def tmdb_config() -> tuple[str, str]:
    """``(api_key, language)`` for TMDB artwork. An empty key disables TMDB
    and leaves the first-video thumbnail as the only source."""
    api_key = await get_setting("tmdb_api_key", settings.TMDB_API_KEY)
    language = await get_setting("tmdb_language", settings.TMDB_LANGUAGE or "en")
    return api_key.strip(), language.strip() or "en"


async def artwork_enabled() -> bool:
    return await get_setting("subscription_artwork", "true") != "false"
