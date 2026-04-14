"""
yt-dlp integration — two entry points:

  extract_metadata(url)  — synchronous, call via asyncio.to_thread() in routes
  run_download(...)      — synchronous, runs inside a ProcessPoolExecutor worker

Both are module-level functions so they remain picklable.
"""

from yt_dlp import YoutubeDL


def _quality_label(f: dict) -> str:
    """Derives a human-readable quality label from a yt-dlp format dict."""
    vcodec = f.get("vcodec", "none")
    acodec = f.get("acodec", "none")

    if vcodec == "none" and acodec != "none":
        return f"audio only ({f.get('ext', '?')})"

    height = f.get("height")
    if height:
        return f"{height}p"

    note = f.get("format_note", "")
    if note:
        return note

    return f.get("format_id", "?")


def _find_ffmpeg() -> str | None:
    """Return the path to ffmpeg, checking PATH and common install locations."""
    import shutil
    path = shutil.which("ffmpeg")
    if path:
        return path
    # Check winget install location on Windows
    import os, glob
    winget_pattern = os.path.expanduser(
        "~/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/ffmpeg-*-full_build/bin/ffmpeg.exe"
    )
    matches = glob.glob(winget_pattern)
    if matches:
        return matches[0]
    return None


def _is_ffmpeg_available() -> bool:
    return _find_ffmpeg() is not None


def _normalize_formats(raw_formats: list[dict]) -> list[dict]:
    formats = []
    seen_ids: set[str] = set()
    for f in raw_formats:
        fid = f.get("format_id", "")
        if fid in seen_ids:
            continue
        seen_ids.add(fid)
        formats.append({
            "format_id": fid,
            "ext": f.get("ext", ""),
            "quality": _quality_label(f),
            "filesize": f.get("filesize") or f.get("filesize_approx"),
        })
    return formats


def extract_metadata(url: str) -> dict:
    """
    Fetch video metadata without downloading.
    Returns: {url, title, thumbnail, duration, formats}
    Raises ValueError for playlist URLs (use subscriptions for those).
    """
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
    }
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    # Playlist detected — tell the frontend to use the playlist endpoint
    if info.get("_type") == "playlist" or "entries" in info:
        raise ValueError("PLAYLIST_URL")

    # Reverse so best quality appears first in the picker
    formats = list(reversed(_normalize_formats(info.get("formats", []))))
    return {
        "url": url,
        "title": info.get("title", "Unknown"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "formats": formats,
    }


def extract_playlist(url: str) -> dict:
    """
    Fetch flat playlist metadata without downloading.
    Returns: {title, entries: [{id, url, title, upload_date}]}
    """
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
    }
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise ValueError("Could not extract playlist info from URL")

    entries = info.get("entries") or []
    return {
        "title": info.get("title") or info.get("playlist_title") or "Unknown Playlist",
        "entries": [
            {
                "id": e.get("id", ""),
                "url": _entry_url(e),
                "title": e.get("title"),
                "upload_date": e.get("upload_date"),
            }
            for e in entries
            if e and e.get("id")
        ],
    }


def _entry_url(e: dict) -> str:
    """
    Return a guaranteed full URL for a flat-playlist entry.

    yt-dlp's extract_flat sometimes returns just the video ID in the 'url'
    field (e.g. 'dQw4w9WgXcQ') rather than a full URL. We always prefer
    'webpage_url' (which is always absolute when present), then fall back
    to 'url' only if it looks like a full URL, otherwise construct one.
    """
    webpage_url = e.get("webpage_url") or ""
    if webpage_url.startswith(("http://", "https://")):
        return webpage_url

    raw_url = e.get("url") or ""
    if raw_url.startswith(("http://", "https://")):
        return raw_url

    # Bare ID — reconstruct based on extractor key if present
    ie_key = e.get("ie_key") or ""
    video_id = e.get("id", "")
    if "youtube" in ie_key.lower() or not ie_key:
        return f"https://www.youtube.com/watch?v={video_id}"
    return raw_url or f"https://www.youtube.com/watch?v={video_id}"


def _apply_settings(ydl_opts: dict, s: dict) -> None:
    """Merge saved app settings into ydl_opts in-place."""
    import json

    def _bool(key: str) -> bool:
        return s.get(key, "false") == "true"

    def _int(key: str, default: int | None = None) -> int | None:
        v = s.get(key, "")
        try:
            return int(v) if v else default
        except ValueError:
            return default

    # ffmpeg location override
    if s.get("ffmpeg_location"):
        import os
        ydl_opts["ffmpeg_location"] = os.path.dirname(s["ffmpeg_location"])

    # Subtitles
    if _bool("write_subs"):
        ydl_opts["writesubtitles"] = True
        langs = s.get("sub_langs", "en")
        ydl_opts["subtitleslangs"] = [l.strip() for l in langs.split(",") if l.strip()]
    if _bool("write_auto_subs"):
        ydl_opts["writeautomaticsub"] = True
    if _bool("embed_subs"):
        ydl_opts["embedsubtitles"] = True
    if s.get("convert_subs"):
        ydl_opts["convertsubtitles"] = s["convert_subs"]

    # Metadata & thumbnails
    if _bool("embed_thumbnail"):
        ydl_opts["embedthumbnail"] = True
    if _bool("write_thumbnail"):
        ydl_opts["writethumbnail"] = True
    if _bool("write_info_json"):
        ydl_opts["writeinfojson"] = True
    if _bool("write_description"):
        ydl_opts["writedescription"] = True
    if _bool("embed_metadata"):
        ydl_opts["addmetadata"] = True
    if _bool("embed_chapters"):
        ydl_opts["addchapters"] = True

    # Post-processing
    if s.get("sponsorblock_remove"):
        cats = [c.strip() for c in s["sponsorblock_remove"].split(",") if c.strip()]
        if cats:
            ydl_opts["sponsorblock_remove"] = cats
    if _bool("keep_video"):
        ydl_opts["keepvideo"] = True

    # Download tuning
    n_frags = _int("concurrent_fragments")
    if n_frags and n_frags > 1:
        ydl_opts["concurrent_fragment_downloads"] = n_frags
    retries = _int("retries")
    if retries is not None:
        ydl_opts["retries"] = retries
    frag_retries = _int("fragment_retries")
    if frag_retries is not None:
        ydl_opts["fragment_retries"] = frag_retries
    if s.get("rate_limit"):
        ydl_opts["ratelimit"] = s["rate_limit"]
    sock_timeout = _int("socket_timeout")
    if sock_timeout is not None:
        ydl_opts["socket_timeout"] = sock_timeout
    if not _bool("continue_partial"):
        ydl_opts["continuedl"] = False
    if _bool("no_overwrites"):
        ydl_opts["nooverwrites"] = True

    # Output
    if _bool("restrict_filenames"):
        ydl_opts["restrictfilenames"] = True

    # Format
    if _bool("prefer_free_formats"):
        ydl_opts["prefer_free_formats"] = True
    if s.get("format_sort"):
        ydl_opts["format_sort"] = s["format_sort"].split(",")

    # Auth
    if s.get("cookies_from_browser"):
        ydl_opts["cookiesfrombrowser"] = (s["cookies_from_browser"],)
    if s.get("username"):
        ydl_opts["username"] = s["username"]
    if s.get("password"):
        ydl_opts["password"] = s["password"]

    # Advanced raw JSON — applied last, overrides everything
    if s.get("raw_options_json"):
        try:
            extra = json.loads(s["raw_options_json"])
            if isinstance(extra, dict):
                ydl_opts.update(extra)
        except (json.JSONDecodeError, ValueError):
            pass


def run_download(
    download_id: int,
    url: str,
    format_spec: str,
    output_dir: str,
    queue: object,           # queue.Queue (thread-safe)
    cancel_event: object,    # threading.Event
    app_settings: dict | None = None,  # key/value from Setting table
) -> str:
    """
    Execute the download in a ThreadPoolExecutor worker thread.
    Returns the output file path on success. Raises on failure or cancellation.
    """
    from app.ytdl.progress import make_progress_hook

    hook = make_progress_hook(download_id, queue, cancel_event)

    ffmpeg_path = _find_ffmpeg()
    ydl_opts: dict = {
        "format": format_spec,
        "outtmpl": f"{output_dir}/%(title)s.%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
    }
    # Tell yt-dlp where ffmpeg lives and enable merge options
    if ffmpeg_path:
        import os
        ydl_opts["ffmpeg_location"] = os.path.dirname(ffmpeg_path)
        ydl_opts["merge_output_format"] = "mp4"

    # Merge app settings on top (user-configured overrides)
    if app_settings:
        _apply_settings(ydl_opts, app_settings)

    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # Get the actual output path
    requested = info.get("requested_downloads", [])
    if requested:
        return requested[0].get("filepath") or requested[0].get("filename", "")
    return ydl.prepare_filename(info)
