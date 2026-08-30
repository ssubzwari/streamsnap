"""Runtime (re)loading of the isolated yt-dlp package.

yt-dlp is installed into an isolated directory (``settings.YTDLP_DIR`` — a Docker
named volume mounted at ``/ytdlp``) so that the in-app "Update to latest" button
survives container restarts without rebuilding the image.

Because an update writes new files while the server process is already running,
the previously-imported ``yt_dlp`` modules stay cached in ``sys.modules`` and the
new version never takes effect until a full process restart. ``reload_ytdlp()``
drops those cached modules so the next ``import yt_dlp`` picks up the new files.

For this to work, every consumer must import ``yt_dlp`` lazily (inside the
function that uses it), never at module import time.
"""

import pathlib
import sys

from app.config import settings


def ensure_on_path() -> None:
    """Prepend YTDLP_DIR to ``sys.path`` so its yt-dlp shadows any other install."""
    if not settings.YTDLP_DIR:
        return
    target = str(pathlib.Path(settings.YTDLP_DIR).resolve())
    pathlib.Path(target).mkdir(parents=True, exist_ok=True)
    if sys.path[:1] == [target]:
        return
    while target in sys.path:
        sys.path.remove(target)
    sys.path.insert(0, target)


def reload_ytdlp() -> None:
    """Purge cached ``yt_dlp`` modules so the next import reloads them from disk."""
    import importlib

    ensure_on_path()
    for name in [m for m in sys.modules if m == "yt_dlp" or m.startswith("yt_dlp.")]:
        del sys.modules[name]
    importlib.invalidate_caches()
