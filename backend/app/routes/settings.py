from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Setting
from app.schemas import SettingsMap

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Keys the frontend is allowed to read/write
ALLOWED_KEYS = {
    "subscription_check_interval_minutes",
    "auto_start",
    "download_folder",
    "items_limit",
    "option_presets",
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
