"""TMDB artwork source.

Resolves a subscription to a TMDB title (TV show or movie) and writes proper
show artwork into its folder — poster, background/fanart, clear logo, banner,
square art and per-season posters — for Plex / Jellyfin / Emby / Kodi to pick
up as local media assets.

Only the standard library is used for HTTP so the backend keeps its current
dependency set. Every call is blocking; run it in a thread.
"""

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

API_BASE = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p/original"

_TIMEOUT = 20

# Local-media file names written from each TMDB image type. "square" and
# "banner" have no TMDB equivalent — they are cropped from the poster and the
# backdrop respectively (see _derive_square / _derive_banner).
POSTER_NAME = "poster"
BACKGROUND_NAME = "background"
LOGO_NAME = "logo"
SQUARE_NAME = "square"
BANNER_NAME = "banner"

_IMAGE_EXTS = ("jpg", "jpeg", "png", "webp", "bmp", "gif")


class TmdbError(Exception):
    """A TMDB request failed (bad key, rate limit, network)."""


# ── HTTP ──────────────────────────────────────────────────────────────────────

def _is_bearer(api_key: str) -> bool:
    """TMDB v4 read-access tokens are JWTs and go in an Authorization header;
    v3 keys are 32 hex chars and go in the query string."""
    return api_key.startswith("eyJ")


def _get_json(path: str, api_key: str, **params) -> dict:
    params = {k: v for k, v in params.items() if v not in (None, "")}
    headers = {"Accept": "application/json"}
    if _is_bearer(api_key):
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        params["api_key"] = api_key

    url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("status_message", "")
        except Exception:  # noqa: BLE001
            pass
        raise TmdbError(f"TMDB {path} → HTTP {exc.code} {detail}".strip()) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise TmdbError(f"TMDB {path} failed: {exc}") from exc


def _download(url: str, dest: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "StreamSnap"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp, open(dest, "wb") as fh:
            while chunk := resp.read(64 * 1024):
                fh.write(chunk)
        return True
    except (urllib.error.URLError, OSError) as exc:
        logger.warning("tmdb: image download failed (%s): %s", url, exc)
        return False


# ── Search ────────────────────────────────────────────────────────────────────

# Channel titles carry noise TMDB never matches on ("Topic", "Official",
# "- Season 2", a trailing "HD"). Strip it before searching.
_NOISE = re.compile(
    r"\s*[-–|]\s*(official|topic|channel|hd|4k)\b.*$|"
    r"\s*\b(official|vevo)\b\s*(channel)?$|"
    r"\s*[-–|]?\s*season\s*\d+.*$|"
    r"\s*\(\d{4}\)\s*$",
    re.IGNORECASE,
)


def clean_title(title: str) -> str:
    cleaned = _NOISE.sub("", title or "").strip(" -–|_")
    return cleaned or (title or "").strip()


def search_title(title: str, api_key: str, *, language: str = "en") -> dict | None:
    """Best TMDB match for *title*. Returns ``{"kind", "id", "name", "year"}``
    or None. TV is preferred over movies — subscriptions are series-shaped."""
    query = clean_title(title)
    if not query:
        return None

    data = _get_json("/search/multi", api_key, query=query, language=language,
                     include_adult="false")
    results = [
        r for r in (data.get("results") or [])
        if r.get("media_type") in ("tv", "movie")
    ]
    if not results:
        return None

    def rank(r: dict) -> tuple:
        name = (r.get("name") or r.get("title") or "").lower()
        exact = name == query.lower()
        return (not exact, r.get("media_type") != "tv", -(r.get("popularity") or 0.0))

    best = sorted(results, key=rank)[0]
    date = best.get("first_air_date") or best.get("release_date") or ""
    return {
        "kind": best["media_type"],
        "id": best["id"],
        "name": best.get("name") or best.get("title") or query,
        "year": date[:4] or None,
    }


# ── Image selection ───────────────────────────────────────────────────────────

def _pick(images: list[dict], language: str, *, prefer_textless: bool = False) -> dict | None:
    """Highest-rated image, preferring the wanted language (or no language at
    all for backdrops, which read better without burned-in titles)."""
    if not images:
        return None

    def rank(img: dict) -> tuple:
        iso = img.get("iso_639_1")
        if prefer_textless:
            lang_rank = 0 if iso is None else (1 if iso == language else 2)
        else:
            lang_rank = 0 if iso == language else (1 if iso is None else 2)
        return (lang_rank, -(img.get("vote_average") or 0.0), -(img.get("width") or 0))

    return sorted(images, key=rank)[0]


def get_images(kind: str, tmdb_id: int, api_key: str, *, language: str = "en") -> dict:
    langs = ",".join(dict.fromkeys([language, "en", "null"]))
    return _get_json(f"/{kind}/{tmdb_id}/images", api_key, include_image_language=langs)


def get_seasons(tmdb_id: int, api_key: str, *, language: str = "en") -> list[dict]:
    data = _get_json(f"/tv/{tmdb_id}", api_key, language=language)
    return [s for s in (data.get("seasons") or []) if s.get("poster_path")]


# ── Writing ───────────────────────────────────────────────────────────────────

def _clear_stale(folder: str, name: str, keep: str) -> None:
    """Drop earlier copies of *name* in another image format."""
    import glob as _glob

    for stale in _glob.glob(os.path.join(folder, f"{name}.*")):
        if stale != keep and stale.rsplit(".", 1)[-1].lower() in _IMAGE_EXTS:
            try:
                os.remove(stale)
            except OSError:
                pass


def _write_image(file_path: str, folder: str, name: str, ext: str) -> str | None:
    dest = os.path.join(folder, f"{name}.{ext}")
    if not _download(f"{IMAGE_BASE}{file_path}", dest):
        return None
    _clear_stale(folder, name, dest)
    return dest


def _ffmpeg_crop(src: str, dest: str, vf: str) -> bool:
    import subprocess
    from app.ytdl.service import _find_ffmpeg

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return False
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", src, "-vf", vf, "-frames:v", "1", dest],
            capture_output=True, timeout=60, check=True,
        )
        return True
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("tmdb: ffmpeg crop failed for %s: %s", dest, exc)
        return False


def _derive_square(poster: str, folder: str) -> str | None:
    """Square art (1000×1000) — TMDB has no square type, so centre-crop the
    poster's middle square and scale it."""
    dest = os.path.join(folder, f"{SQUARE_NAME}.jpg")
    vf = "crop='min(iw,ih)':'min(iw,ih)',scale=1000:1000"
    if _ffmpeg_crop(poster, dest, vf):
        _clear_stale(folder, SQUARE_NAME, dest)
        return dest
    return None


def _derive_banner(backdrop: str, folder: str) -> str | None:
    """Banner (1000×185, the Kodi/Plex banner ratio) cropped from the backdrop."""
    dest = os.path.join(folder, f"{BANNER_NAME}.jpg")
    vf = "crop=iw:'iw*185/1000',scale=1000:185"
    if _ffmpeg_crop(backdrop, dest, vf):
        _clear_stale(folder, BANNER_NAME, dest)
        return dest
    return None


def fetch_tmdb_artwork(
    folder: str,
    *,
    api_key: str,
    title: str | None = None,
    tmdb_id: int | None = None,
    tmdb_type: str | None = None,
    language: str = "en",
    seasons: bool = True,
) -> dict:
    """Write TMDB artwork for a show into *folder*.

    Returns ``{"matched": {...} | None, "written": [paths], "error": str | None}``.
    Raises nothing — every failure is reported in the dict so callers can fall
    back to the yt-dlp thumbnail.
    """
    result: dict = {"matched": None, "written": [], "error": None}

    if not api_key:
        result["error"] = "no TMDB API key configured"
        return result
    if not os.path.isdir(folder):
        result["error"] = f"folder does not exist: {folder}"
        return result

    try:
        if tmdb_id:
            kind = tmdb_type or "tv"
            match = {"kind": kind, "id": int(tmdb_id), "name": title or "", "year": None}
        else:
            match = search_title(title or "", api_key, language=language)
            if not match:
                result["error"] = f"no TMDB match for {clean_title(title or '')!r}"
                return result
        result["matched"] = match

        images = get_images(match["kind"], match["id"], api_key, language=language)
    except TmdbError as exc:
        result["error"] = str(exc)
        return result

    written: list[str] = []

    poster = _pick(images.get("posters") or [], language)
    poster_path = None
    if poster:
        poster_path = _write_image(poster["file_path"], folder, POSTER_NAME, "jpg")
        if poster_path:
            written.append(poster_path)

    backdrop = _pick(images.get("backdrops") or [], language, prefer_textless=True)
    backdrop_path = None
    if backdrop:
        backdrop_path = _write_image(backdrop["file_path"], folder, BACKGROUND_NAME, "jpg")
        if backdrop_path:
            written.append(backdrop_path)

    logo = _pick(images.get("logos") or [], language)
    if logo:
        # Logos are transparent PNGs (occasionally SVG — skip those, no
        # media server reads them as local artwork).
        ext = logo["file_path"].rsplit(".", 1)[-1].lower()
        if ext in ("png", "jpg", "jpeg", "webp"):
            logo_path = _write_image(logo["file_path"], folder, LOGO_NAME, ext)
            if logo_path:
                written.append(logo_path)

    if poster_path:
        square = _derive_square(poster_path, folder)
        if square:
            written.append(square)
    if backdrop_path:
        banner = _derive_banner(backdrop_path, folder)
        if banner:
            written.append(banner)

    if seasons and match["kind"] == "tv":
        try:
            for season in get_seasons(match["id"], api_key, language=language):
                num = season.get("season_number")
                if num is None:
                    continue
                name = "season-specials" if num == 0 else f"season{num:02d}"
                path = _write_image(season["poster_path"], folder, f"{name}-poster", "jpg")
                if path:
                    written.append(path)
        except TmdbError as exc:
            logger.warning("tmdb: season posters skipped: %s", exc)

    result["written"] = written
    if not written:
        result["error"] = result["error"] or "TMDB returned no usable images"
    return result
