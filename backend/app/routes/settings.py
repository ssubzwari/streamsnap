from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Setting
from app.schemas import SettingsMap

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Keys the frontend is allowed to read/write
ALLOWED_KEYS = {
    # General / behavior
    "subscription_check_interval_minutes",
    "auto_start",
    "download_folder",
    "items_limit",
    "option_presets",
    # Format
    "format_spec",
    "quality_cap",
    "prefer_codec",
    "audio_codec",
    "merge_container",
    "prefer_free_formats",
    "format_sort",
    # Subtitles
    "write_subs",
    "sub_langs",
    "write_auto_subs",
    "embed_subs",
    "convert_subs",
    # Metadata & Thumbnails
    "embed_thumbnail",
    "write_thumbnail",
    "write_info_json",
    "write_description",
    "embed_metadata",
    "embed_chapters",
    # Post-processing
    "sponsorblock_remove",
    "ffmpeg_location",
    "keep_video",
    # Download
    "concurrent_fragments",
    "retries",
    "fragment_retries",
    "rate_limit",
    "socket_timeout",
    "continue_partial",
    "no_overwrites",
    # Output
    "output_template",
    "restrict_filenames",
    "temp_path",
    # Auth
    "cookies_from_browser",
    "username",
    "password",
    # Advanced
    "raw_options_json",
}


@router.get("", response_model=SettingsMap)
async def get_settings(session: AsyncSession = Depends(get_session)) -> SettingsMap:
    result = await session.execute(select(Setting))
    return SettingsMap(settings={s.key: s.value for s in result.scalars()})


@router.put("", response_model=SettingsMap)
async def update_settings(
    body: SettingsMap,
    session: AsyncSession = Depends(get_session),
) -> SettingsMap:
    for key, value in body.settings.items():
        if key not in ALLOWED_KEYS:
            continue
        setting = await session.get(Setting, key)
        if setting is None:
            setting = Setting(key=key, value=value)
            session.add(setting)
        else:
            setting.value = value
    await session.commit()
    result = await session.execute(select(Setting))
    return SettingsMap(settings={s.key: s.value for s in result.scalars()})
