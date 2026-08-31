import os
import pathlib
import re


def safe_folder_name(name: str) -> str:
    """Sanitize a playlist title to a safe directory name on Windows & Linux."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    safe = re.sub(r'[\s_]+', " ", safe).strip("_. ")
    return safe[:80] or "playlist"


def subscription_download_dir(sub, base_dir: str) -> str:
    """The folder a subscription's videos belong in.

    Prefer the stored ``download_dir``; fall back to reconstructing it from the
    title for subscriptions created before that column existed.
    """
    if getattr(sub, "download_dir", None):
        return sub.download_dir
    folder = safe_folder_name(sub.title or f"subscription {getattr(sub, 'id', '')}")
    return str(pathlib.Path(base_dir) / folder)


def category_subdir(
    category: str | None,
    subcategory: str | None,
    tag: str | None,
) -> str:
    """Build a sanitized relative path from category/subcategory/tag.

    Empty levels are skipped — so passing only ("Movie", None, None) yields
    "Movie", and ("TV", "Show", "Season 1") yields "TV/Show/Season 1".
    Returns "" when all three are empty so callers can join unconditionally.
    """
    parts = [
        safe_folder_name(p)
        for p in (category, subcategory, tag)
        if p and p.strip()
    ]
    return "/".join(parts)


# Extensions we consider "a finished media file" when probing the download
# folder. Kept in sync with the container/audio codecs yt-dlp commonly emits.
MEDIA_EXTS: tuple[str, ...] = (
    ".mp4", ".mkv", ".webm", ".mov", ".avi",
    ".m4a", ".mp3", ".opus", ".flac", ".wav", ".aac", ".ogg",
)

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")
_FCODE_RE = re.compile(r"\.f\d+$")

# Zero-pad a single-digit episode number: "Episode 1" → "Episode 01",
# "EP 2" → "EP 02", "S01E3" → "S01E03", "Ep_4" → "Ep_04". Episodes 10+ are
# left alone. Mirrors admin's rename.sh but requires the keyword not to be
# mid-word (so "Take 5", "Live 8", "The Rise 3" are untouched); a digit
# before the "E" is allowed for the SxxExx pattern.
_EPISODE_PAD_RE = re.compile(
    r"(?<![A-Za-z])(episode|ep|e)([ ._-]*)([1-9])(?![0-9])",
    re.IGNORECASE,
)
_EPISODE_UNPAD_RE = re.compile(
    r"(?<![A-Za-z])(episode|ep|e)([ ._-]*)0+([1-9][0-9]*)",
    re.IGNORECASE,
)


def pad_episode_numbers(name: str) -> str:
    """Zero-pad single-digit episode numbers in a filename or title."""
    return _EPISODE_PAD_RE.sub(r"\g<1>\g<2>0\g<3>", name)


def _normalize_stem(name: str) -> str:
    """Lowercase, strip every non-alphanumeric char. Makes filename matching
    robust to the small differences between yt-dlp's sanitization rules and
    the title string we carry in the DB (spaces, punctuation, case).

    Episode numbers are un-padded ("Episode 06" → "episode6") so a title of
    "Episode 6" still matches a file renamed to "Episode 06" on disk."""
    stem = os.path.splitext(name)[0]
    stem = _FCODE_RE.sub("", stem)
    stem = _EPISODE_UNPAD_RE.sub(r"\g<1>\g<3>", stem)
    return _NORMALIZE_RE.sub("", stem.lower())


def pad_episode_files(folder: str) -> list[tuple[str, str]]:
    """Zero-pad single-digit episode numbers for every file in *folder*.

    Returns the list of (old_name, new_name) pairs that were renamed.
    Skips a rename when the target already exists.
    """
    base = pathlib.Path(folder)
    if not base.is_dir():
        return []
    renamed: list[tuple[str, str]] = []
    for entry in sorted(base.iterdir()):
        if not entry.is_file():
            continue
        new_name = pad_episode_numbers(entry.name)
        if new_name == entry.name:
            continue
        target = base / new_name
        if target.exists():
            continue
        entry.rename(target)
        renamed.append((entry.name, new_name))
    return renamed


_YT_HOSTS = ("youtube.com", "youtu.be", "music.youtube.com", "m.youtube.com")
_YT_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})")


def youtube_thumbnail_url(url: str | None, video_id: str | None = None) -> str | None:
    """Best-effort thumbnail URL for a YouTube video.

    Used to give subscription/playlist notifications an image up front,
    before yt-dlp has run and populated the real thumbnail. Returns None
    for non-YouTube URLs.
    """
    vid = video_id
    if not vid and url:
        if not any(h in url for h in _YT_HOSTS):
            return None
        m = _YT_ID_RE.search(url)
        vid = m.group(1) if m else None
    if not vid:
        return None
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"


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
