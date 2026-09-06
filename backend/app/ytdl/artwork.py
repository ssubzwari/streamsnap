"""Subscription artwork — grab the first video's thumbnail and drop
``poster.jpg`` + ``background.jpg`` into the show folder so Plex picks them
up as the poster and the fanart/backdrop.
"""

import glob
import logging
import os
import shutil
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# Plex local-media names. poster = the vertical/box art, background = the
# widescreen backdrop (Plex also accepts "fanart"/"art" for the latter).
_ARTWORK_NAMES = ("poster", "background")


def fetch_playlist_artwork(video_url: str, folder: str, *, overwrite: bool = True) -> list[str]:
    """Download *video_url*'s thumbnail and write it as poster.jpg +
    background.jpg inside *folder*. Returns the paths written (best-effort —
    logs and returns [] on any failure)."""
    from yt_dlp import YoutubeDL

    if not video_url or not os.path.isdir(folder):
        return []

    if not overwrite and all(
        os.path.exists(os.path.join(folder, f"{n}.jpg")) for n in _ARTWORK_NAMES
    ):
        return []

    with tempfile.TemporaryDirectory() as tmp:
        opts = {
            "skip_download": True,
            "writethumbnail": True,
            "outtmpl": {"default": os.path.join(tmp, "art.%(ext)s")},
            "quiet": True,
            "no_warnings": True,
        }
        try:
            with YoutubeDL(opts) as ydl:
                ydl.download([video_url])
        except Exception as exc:  # noqa: BLE001
            logger.warning("artwork: thumbnail download failed for %s: %s", video_url, exc)
            return []

        candidates = [
            p for p in glob.glob(os.path.join(tmp, "art.*"))
            if p.rsplit(".", 1)[-1].lower() in ("jpg", "jpeg", "png", "webp")
        ]
        if not candidates:
            logger.warning("artwork: no thumbnail file produced for %s", video_url)
            return []
        candidates.sort(key=lambda p: 0 if p.lower().endswith((".jpg", ".jpeg")) else 1)
        src = candidates[0]

        # Plex wants jpg/png. Convert webp/png → jpg with ffmpeg; if that
        # fails, fall back to copying whatever we got.
        jpg = os.path.join(tmp, "art_final.jpg")
        if src.lower().endswith((".jpg", ".jpeg")):
            jpg, ext = src, ".jpg"
        else:
            ext = ".jpg"
            ffmpeg = _ffmpeg_bin()
            if ffmpeg and _run_ffmpeg([ffmpeg, "-y", "-i", src, jpg]):
                pass
            else:
                jpg, ext = src, os.path.splitext(src)[1]

        written: list[str] = []
        for name in _ARTWORK_NAMES:
            # Drop any previous copy in another format (e.g. an old .webp).
            keep = os.path.join(folder, f"{name}{ext}")
            for stale in glob.glob(os.path.join(folder, f"{name}.*")):
                if stale != keep and stale.rsplit(".", 1)[-1].lower() in (
                    "jpg", "jpeg", "png", "webp", "bmp", "gif"
                ):
                    try:
                        os.remove(stale)
                    except OSError:
                        pass
            dst = os.path.join(folder, f"{name}{ext}")
            try:
                shutil.copyfile(jpg, dst)
                written.append(dst)
            except OSError as exc:
                logger.warning("artwork: could not write %s: %s", dst, exc)
        return written


def _ffmpeg_bin() -> str | None:
    from app.ytdl.service import _find_ffmpeg

    return _find_ffmpeg()


def _run_ffmpeg(cmd: list[str]) -> bool:
    try:
        subprocess.run(cmd, capture_output=True, timeout=30, check=True)
        return True
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("artwork: ffmpeg convert failed: %s", exc)
        return False
