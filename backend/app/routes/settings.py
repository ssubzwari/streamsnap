import asyncio
import glob
import os
import pathlib
import re
import shutil
import sys
from datetime import datetime
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import SCHEMA_VERSION, engine, get_session
from app.models import Download, Notification, NotificationChannel, SeenVideo, Setting, Subscription
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


def _version_key(v: str) -> tuple:
    return tuple(int(n) for n in re.findall(r"\d+", v)) or (0,)


def _installed_version(target_dir: str) -> str:
    """Read the yt-dlp version from dist-info METADATA in *target_dir*.

    A ``pip install --target`` can leave several ``yt_dlp-*.dist-info`` dirs
    behind (it does not uninstall the previous version), so pick the highest.
    """
    if target_dir:
        pattern = str(pathlib.Path(target_dir) / "yt_dlp-*.dist-info" / "METADATA")
        found: list[str] = []
        for meta_path in glob.glob(pattern):
            for line in pathlib.Path(meta_path).read_text(encoding="utf-8").splitlines():
                if line.startswith("Version:"):
                    found.append(line.split(":", 1)[1].strip())
                    break
        if found:
            return max(found, key=_version_key)
    try:
        import importlib.metadata
        return importlib.metadata.version("yt-dlp")
    except Exception:
        return "unknown"


def _clean_target(target_dir: str) -> None:
    """Wipe a previous yt-dlp install out of *target_dir* before reinstalling.

    Everything in the dir is a pip-installed package except ``db-backups`` (the
    DB admin backup folder shares this volume), which we preserve. A clean dir
    means no leftover modules or stale ``.dist-info`` from the prior version.
    """
    base = pathlib.Path(target_dir)
    if not base.is_dir():
        return
    for child in base.iterdir():
        if child.name == "db-backups":
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            try:
                child.unlink()
            except OSError:
                pass


def _pip_upgrade_cmd(target_dir: str) -> list[str]:
    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "yt-dlp"]
    if target_dir:
        cmd += ["--target", target_dir]
    else:
        cmd.insert(4, "--upgrade")
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
    "pad_episode_numbers",
    "subscription_artwork",
    "tmdb_api_key",
    "tmdb_language",
    # Download
    "max_concurrent_downloads",
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
    "notify_on_download_start",
    "notify_on_complete",
    "notify_on_failed",
    "notify_on_playlist_complete",
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

    # Apply concurrency changes to the running queue immediately.
    if "max_concurrent_downloads" in body.settings:
        from app.services.download_manager import download_manager

        try:
            await download_manager.set_concurrency(
                int(body.settings["max_concurrent_downloads"])
            )
        except (TypeError, ValueError):
            pass

    result = await session.execute(select(Setting))
    return SettingsMap(settings={s.key: s.value for s in result.scalars()})


# ── yt-dlp management ─────────────────────────────────────────────────────────

@router.get("/ytdlp-version")
async def ytdlp_version() -> dict:
    """Return the installed yt-dlp version and the configured install dir.

    When an isolated YTDLP_DIR is configured (Docker volume) the on-disk version
    there is the source of truth — it reflects the last successful update and
    survives restarts. The in-process import may still be a previous version
    until the next download reloads it, so we report the disk version.
    """
    target_dir = settings.YTDLP_DIR
    version = _installed_version(target_dir) if target_dir else _current_version()
    return {
        "version": version,
        "loaded_version": _current_version(),
        "ytdlp_dir": target_dir or None,
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
    old_version = _installed_version(settings.YTDLP_DIR) if settings.YTDLP_DIR else _current_version()
    target_dir = settings.YTDLP_DIR

    # Fresh install into the isolated dir — no leftovers from the prior version.
    if target_dir:
        _clean_target(target_dir)

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

    # Drop cached yt_dlp modules so the next download/metadata call re-imports
    # the just-installed version without needing a server restart.
    try:
        from app.ytdl.loader import reload_ytdlp
        reload_ytdlp()
    except Exception:
        pass

    new_version = _installed_version(target_dir) if target_dir else _current_version()
    return {
        "old_version": old_version,
        "new_version": new_version,
        "updated": old_version != new_version,
        "ytdlp_dir": target_dir or None,
    }


# ── Schema version ───────────────────────────────────────────────────────────

@router.get("/db/schema-version")
async def db_schema_version(session: AsyncSession = Depends(get_session)) -> dict:
    """Return the current DB schema version and the target version the app expects."""
    row = await session.get(Setting, "schema_version")
    current = int(row.value) if row and row.value else 0
    return {
        "current_version": current,
        "target_version": SCHEMA_VERSION,
        "up_to_date": current == SCHEMA_VERSION,
    }


# ── Database admin ────────────────────────────────────────────────────────────
#
# Backups live in the same mount we use for the yt-dlp install when it's
# configured (YTDLP_DIR → /ytdlp in Docker), so admins only have to worry
# about one persistent volume. On local dev YTDLP_DIR is empty and we fall
# back to ./backups next to the DB file.

def _backup_dir() -> pathlib.Path:
    base = settings.YTDLP_DIR.strip() if settings.YTDLP_DIR else ""
    if base:
        out = pathlib.Path(base) / "db-backups"
    else:
        out = pathlib.Path.cwd() / "backups"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _db_path_from_url(url: str) -> pathlib.Path:
    """Extract the on-disk file path from a sqlite/aiosqlite DB_URL."""
    # sqlite+aiosqlite:///./streamsnap.db → ./streamsnap.db
    # sqlite+aiosqlite:////abs/path.db    → /abs/path.db
    parsed = urlparse(url)
    raw = parsed.path or url.split("///", 1)[-1]
    # Strip the leading "/" only when a relative path was stored as ///./file
    if raw.startswith("/") and raw[1:3] in ("./", ".\\"):
        raw = raw[1:]
    return pathlib.Path(raw).resolve()


_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


@router.get("/db/backups")
async def list_db_backups() -> dict:
    """List existing database backups in the backup directory."""
    backups = []
    # New backups are "streamsnap-*.db"; keep listing legacy "metubeplus-*.db" too.
    files = {
        *_backup_dir().glob("streamsnap-*.db"),
        *_backup_dir().glob("metubeplus-*.db"),
    }
    for p in sorted(files, key=lambda p: p.name, reverse=True):
        try:
            stat = p.stat()
            backups.append({
                "name": p.name,
                "size": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
        except OSError:
            continue
    return {"directory": str(_backup_dir()), "backups": backups}


@router.post("/db/backup")
async def backup_db() -> dict:
    """Snapshot the SQLite database to a timestamped file in the backup directory.

    Uses SQLite's built-in backup API (safe while the app is writing) so the
    file is guaranteed to be a consistent copy even if a download is in
    progress.
    """
    import sqlite3

    src = _db_path_from_url(settings.DB_URL)
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Database file not found at {src}")

    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    dst = _backup_dir() / f"streamsnap-{ts}.db"

    def _do_backup() -> None:
        # Close and reopen through sqlite3 APIs so we can use .backup()
        # without touching the async engine's connection pool.
        src_con = sqlite3.connect(str(src))
        dst_con = sqlite3.connect(str(dst))
        try:
            with dst_con:
                src_con.backup(dst_con)
        finally:
            src_con.close()
            dst_con.close()

    try:
        await asyncio.to_thread(_do_backup)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Backup failed: {exc}")

    return {
        "name": dst.name,
        "path": str(dst),
        "size": dst.stat().st_size,
        "created_at": datetime.utcnow().isoformat(),
    }


class RestoreRequest(BaseModel):
    name: str


@router.post("/db/restore")
async def restore_db(req: RestoreRequest) -> dict:
    """Replace the live database with a previously-taken backup.

    All async connections are disposed first so SQLite releases the file
    handle; after copy, the engine will re-open the restored DB on the
    next query. Existing websocket sessions keep working.
    """
    if not _SAFE_NAME.match(req.name) or not req.name.endswith(".db"):
        raise HTTPException(status_code=400, detail="Invalid backup name")

    src = _backup_dir() / req.name
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {req.name}")

    dst = _db_path_from_url(settings.DB_URL)

    try:
        # Drop all pooled connections so we can overwrite the file on Windows.
        await engine.dispose()

        def _do_restore() -> None:
            # Write to a .tmp first, then replace atomically so we don't
            # leave a half-copied DB if something goes wrong mid-write.
            tmp = dst.with_suffix(dst.suffix + ".tmp")
            shutil.copy2(src, tmp)
            os.replace(tmp, dst)

        await asyncio.to_thread(_do_restore)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Restore failed: {exc}")

    return {"restored_from": req.name, "path": str(dst)}


@router.get("/db/backups/{name}/download")
async def download_db_backup(name: str) -> FileResponse:
    """Stream a backup file to the browser for local download."""
    if not _SAFE_NAME.match(name) or not name.endswith(".db"):
        raise HTTPException(status_code=400, detail="Invalid backup name")
    path = _backup_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {name}")
    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename=name,
    )


@router.post("/db/backups/upload")
async def upload_db_backup(file: UploadFile = File(...)) -> dict:
    """Accept a .db backup file uploaded from the browser and save it to the backup directory."""
    filename = file.filename or ""
    if not _SAFE_NAME.match(filename) or not filename.endswith(".db"):
        raise HTTPException(status_code=400, detail="File must be a .db file with a safe name")

    dst = _backup_dir() / filename
    try:
        contents = await file.read()
        await asyncio.to_thread(dst.write_bytes, contents)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

    stat = dst.stat()
    return {
        "name": dst.name,
        "path": str(dst),
        "size": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


@router.delete("/db/backups/{name}", status_code=204)
async def delete_db_backup(name: str) -> None:
    """Delete a single backup file by name."""
    if not _SAFE_NAME.match(name) or not name.endswith(".db"):
        raise HTTPException(status_code=400, detail="Invalid backup name")
    path = _backup_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {name}")
    try:
        path.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete backup: {exc}")


@router.post("/db/initialize")
async def initialize_db(session: AsyncSession = Depends(get_session)) -> dict:
    """
    Wipe user data (downloads, subscriptions, seen videos, notifications)
    while preserving notification channels and app settings.

    Useful when a user wants a clean slate but doesn't want to re-enter
    their SMTP / Slack / etc. credentials.
    """
    from app.services.subscription_worker import get_scheduler, unschedule_subscription

    counts: dict[str, int] = {}

    # Unschedule every APScheduler job for existing subscriptions BEFORE we
    # delete their rows. Otherwise the jobs keep firing against a now-empty
    # DB, and (more importantly) the scheduler's in-memory state would keep
    # showing "active" subs until the next process restart — which is how
    # users see ghost subscriptions after an Initialize.
    existing_subs = (await session.execute(select(Subscription.id))).scalars().all()
    for sid in existing_subs:
        try:
            await unschedule_subscription(sid)
        except Exception:
            # Missing job is fine — we're trying to cancel it anyway.
            pass

    # Order matters — delete children before parents so FK constraints
    # (even the informational ones SQLite doesn't enforce by default)
    # don't bite us if we turn foreign_keys=ON in the future.
    for model, label in (
        (SeenVideo, "seen_videos"),
        (Download, "downloads"),
        (Subscription, "subscriptions"),
        (Notification, "notifications"),
    ):
        result = await session.execute(sa_delete(model))
        counts[label] = int(result.rowcount or 0)

    # Reclaim primary keys so the next subscription gets id=1 (keeps UI
    # predictable and prevents any lingering id-reuse collisions).
    # sqlite_sequence only exists if tables use AUTOINCREMENT; safe to ignore if missing.
    try:
        await session.execute(
            text("DELETE FROM sqlite_sequence WHERE name IN ('downloads','subscriptions','seen_videos','notifications')")
        )
    except Exception:
        # sqlite_sequence table may not exist in all scenarios (e.g., fresh DB with no sequences yet)
        pass

    await session.commit()

    preserved = {
        "notification_channels": (
            await session.execute(select(NotificationChannel))
        ).scalars().all(),
        "settings": (await session.execute(select(Setting))).scalars().all(),
    }

    return {
        "deleted": counts,
        "preserved": {k: len(v) for k, v in preserved.items()},
    }
