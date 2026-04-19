import os
import pathlib
import re


def safe_folder_name(name: str) -> str:
    """Sanitize a playlist title to a safe directory name on Windows & Linux."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    safe = re.sub(r'[\s_]+', " ", safe).strip("_. ")
    return safe[:80] or "playlist"


# Extensions we consider "a finished media file" when probing the download
# folder. Kept in sync with the container/audio codecs yt-dlp commonly emits.
MEDIA_EXTS: tuple[str, ...] = (
    ".mp4", ".mkv", ".webm", ".mov", ".avi",
    ".m4a", ".mp3", ".opus", ".flac", ".wav", ".aac", ".ogg",
)

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")
_FCODE_RE = re.compile(r"\.f\d+$")


def _normalize_stem(name: str) -> str:
    """Lowercase, strip every non-alphanumeric char. Makes filename matching
    robust to the small differences between yt-dlp's sanitization rules and
    the title string we carry in the DB (spaces, punctuation, case)."""
    stem = os.path.splitext(name)[0]
    stem = _FCODE_RE.sub("", stem)
    return _NORMALIZE_RE.sub("", stem.lower())


def find_existing_file(folder: str, title: str | None) -> str | None:
    """Return the absolute path of an already-downloaded file for *title*
    inside *folder*, or None if no match.

    We don't predict yt-dlp's exact output filename — we walk *folder* and
    match any media file whose normalized stem equals the normalized title.
    Matches the real file on disk, not a DB row, so this survives DB wipes
    and works for files put there by other means.
    """
    if not title:
        return None
    folder_path = pathlib.Path(folder)
    if not folder_path.is_dir():
        return None

    target = _normalize_stem(title)
    if not target:
        return None

    best: str | None = None
    best_rank = 999
    rank_map = {ext: i for i, ext in enumerate(MEDIA_EXTS)}
    for entry in folder_path.iterdir():
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        if ext not in rank_map:
            continue
        if _normalize_stem(entry.name) != target:
            continue
        rank = rank_map[ext]
        if rank < best_rank:
            best = str(entry.resolve())
            best_rank = rank
    return best
