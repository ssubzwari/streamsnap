import asyncio
import glob
import pathlib
import sys

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Setting
from app.schemas import SettingsMap

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ── yt-dlp version helpers ────────────────────────────────────────────────────

def _current_version() -> str:
    """Return the currently-imported yt-dlp version string."""
    try:
        import yt_dlp.version as v  # type: ignore
        return v.__version__
    except Exception:
        return "unknown"


def _installed_version(target_dir: str) -> str:
    """Read yt-dlp version from dist-info METADATA in *target_dir* (after pip install)."""
    if target_dir:
        pattern = str(pathlib.Path(target_dir) / "yt_dlp-*.dist-info" / "METADATA")
        for meta_path in glob.glob(pattern):
            for line in pathlib.Path(meta_path).read_text(encoding="utf-8").splitlines():
                if line.startswith("Version:"):
                    return line.split(":", 1)[1].strip()
    try:
        import importlib.metadata
        return importlib.metadata.version("yt-dlp")
    except Exception:
        return "unknown"


def _pip_upgrade_cmd(target_dir: str) -> list[str]:
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"]
    if target_dir:
        cmd += ["--target", target_dir]
    return cmd


# ── Keys the frontend is allowed to read/write ────────────────────────────────

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
    # Notification suppression
    "notify_on_complete",
    "notify_on_failed",
    "notify_on_new_video",
    "notify_on_subscription_error",
    # Notification summary
    "notify_summary_enabled",
    "notify_summary_interval_hours",
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


# ── yt-dlp management ─────────────────────────────────────────────────────────

@router.get("/ytdlp-version")
async def ytdlp_version() -> dict:
    """Return the currently-loaded yt-dlp version and the configured install dir."""
    return {
        "version": _current_version(),
        "ytdlp_dir": settings.YTDLP_DIR or None,
    }


@router.post("/update-ytdlp")
async def update_ytdlp() -> dict:
    """
    Upgrade yt-dlp to the latest version from PyPI.
    Installs into YTDLP_DIR if configured (Docker volume), otherwise upgrades
    the system/venv package in-place.
    Restart is NOT required — the updated package is active for subsequent
    downloads (new subprocesses pick it up immediately; in-process imports
    reload on next use because run_download runs in a ProcessPoolExecutor).
    """
    old_version = _current_version()
    target_dir = settings.YTDLP_DIR

    cmd = _pip_upgrade_cmd(target_dir)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="pip install timed out after 120 s")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to run pip: {exc}")

    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"pip exited with code {proc.returncode}: {stderr.decode()[-1000:]}",
        )

    new_version = _installed_version(target_dir)
    return {
        "old_version": old_version,
        "new_version": new_version,
        "updated": old_version != new_version,
        "ytdlp_dir": target_dir or None,
    }
