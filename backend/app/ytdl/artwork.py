"""Subscription artwork — grab the first video's thumbnail and drop
``poster.jpg`` + ``background.jpg`` into the show folder so Plex picks them
up as the poster and the fanart/backdrop.
"""

import glob
import logging
import os
import shutil
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
            # Normalise to jpg — Plex is happiest with jpg/png, not webp.
            "postprocessors": [{"key": "FFmpegThumbnailsConvertor", "format": "jpg"}],
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
        # Prefer a real jpg if the convertor made one.
        candidates.sort(key=lambda p: 0 if p.lower().endswith((".jpg", ".jpeg")) else 1)
        src = candidates[0]
        ext = ".jpg" if src.lower().endswith((".jpg", ".jpeg")) else os.path.splitext(src)[1]

        written: list[str] = []
        for name in _ARTWORK_NAMES:
            dst = os.path.join(folder, f"{name}{ext}")
            try:
                shutil.copyfile(src, dst)
                written.append(dst)
            except OSError as exc:
                logger.warning("artwork: could not write %s: %s", dst, exc)
        return written
