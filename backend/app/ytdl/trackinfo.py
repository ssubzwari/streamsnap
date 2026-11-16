"""Derive music tags for a downloaded audio file.

Everything comes from what the download already knows — yt-dlp's ``info_dict``
and the file's own name. No external lookup, so tagging is instant, offline and
can't mismatch a track.

YouTube Music entries carry real ``artist`` / ``track`` / ``album`` fields and
those win. An ordinary video has none, so the file name is parsed as
``Artist - Title`` instead, with the channel name as the last resort.

The field that matters most is **album artist**: Plex files a track under
"Various Artists" when an album's tracks carry no consistent ``ALBUMARTIST``,
so :func:`derive_tags` never returns an artist without also returning an album
artist.

**A playlist is one album.** YouTube Music gives every track the album it was
originally released on, so a 47-track greatest-hits playlist would otherwise
arrive as 47 one-track albums. When a track was downloaded as part of a
playlist, the playlist wins for ``album`` *and* ``album_artist`` — both are then
constant across the folder by construction, which is what Plex groups on. The
per-track ``album`` is still used for a standalone download, where it is right.
"""

import os
import re

# Upload noise that is never part of a track name.
_NOISE = re.compile(
    r"\s*[\(\[][^)\]]*\b(official|lyric|lyrics|audio|video|visualizer|mv|hd|hq|4k|"
    r"remaster(ed)?|explicit|clean|live|music video|with lyrics|full album)\b[^)\]]*[\)\]]|"
    r"\s*[\(\[]\s*(19|20)\d{2}\s*[\)\]]|"
    r"\s*\b(official video|official audio|official music video|lyrics?)\b\s*$",
    re.IGNORECASE,
)

# YouTube's auto-generated artist channels are "<Artist> - Topic".
_TOPIC = re.compile(r"\s*-\s*topic\s*$", re.IGNORECASE)

# Only separators with surrounding whitespace split an artist from a title, so
# hyphenated names ("Jay-Z", "Blink-182") stay intact.
_SEPARATORS = (" - ", " – ", " — ", " | ", " － ")


def clean_title(title: str) -> str:
    cleaned = _NOISE.sub("", title or "")
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip(" -–—|_\"'")


def strip_topic(channel: str | None) -> str | None:
    """``"Radiohead - Topic"`` → ``"Radiohead"``."""
    return _TOPIC.sub("", channel or "").strip() or None


def split_artist_title(name: str) -> tuple[str | None, str]:
    """Split ``"Artist - Track"`` into its parts.

    Returns ``(None, name)`` when there is no separator — the whole string is
    then the track name.
    """
    cleaned = clean_title(name)
    for sep in _SEPARATORS:
        if sep in cleaned:
            left, _, right = cleaned.partition(sep)
            left, right = left.strip(), right.strip()
            if left and right:
                return left, right
    return None, cleaned


def _first(info: dict, *keys: str) -> str | None:
    """First non-empty value among *keys*, flattening yt-dlp's list fields."""
    for key in keys:
        value = info.get(key)
        if isinstance(value, (list, tuple)):
            value = ", ".join(str(v) for v in value if v)
        if isinstance(value, (int, float)):
            value = str(value)
        if value and str(value).strip():
            return str(value).strip()
    return None


def _year(info: dict) -> str | None:
    year = _first(info, "release_year")
    if year:
        return year[:4]
    date = _first(info, "release_date", "upload_date")
    return date[:4] if date and len(date) >= 4 else None


def _album_fields(
    path: str, info: dict, *, artist: str | None, channel: str | None
) -> tuple[str | None, str | None]:
    """The ``(album, album_artist)`` pair a folder's tracks should agree on.

    Plex groups an album by ``(ALBUM, ALBUMARTIST)``, so the two must come out
    the same for every track in a folder or the album splits apart. Both are
    therefore taken from the *playlist* when there is one: the playlist's title
    and its owner are the same for every track in it, while a track's own
    ``album`` / ``album_artist`` are whatever record it was first released on.
    """
    playlist = _first(info, "playlist_title", "playlist")
    if playlist:
        owner = strip_topic(_first(info, "playlist_uploader", "playlist_channel"))
        # `channel` and `artist` vary per track on a multi-artist playlist, but
        # they are constant on the single-artist playlists that make up most of
        # them — and a wrong-but-constant value still groups as one album, which
        # a right-but-varying one does not. The repair pass reconciles a folder
        # that really is mixed, because it can see every file at once.
        return playlist, owner or channel or artist or playlist

    album = _first(info, "album")
    if not album:
        # The download folder is the subscription / playlist name, which is the
        # grouping the user already sees in their library.
        album = os.path.basename(os.path.dirname(path)) or None

    album_artist = _first(info, "album_artist") or artist or channel or album
    return album, album_artist


def derive_tags(path: str, info: dict | None = None) -> dict:
    """Tags for the audio file at *path*.

    *info* is yt-dlp's ``info_dict`` when the file was just downloaded. The file
    name alone is enough — pass nothing and everything is parsed from it.
    """
    info = info or {}
    stem = os.path.splitext(os.path.basename(path))[0]

    file_artist, file_title = split_artist_title(stem)
    channel = strip_topic(_first(info, "uploader", "channel", "creator"))

    # yt-dlp's own fields are authoritative when YouTube supplied them; the file
    # name is what the user sees on disk and is the next best thing.
    artist = _first(info, "artist", "artists") or file_artist or channel
    title = _first(info, "track") or file_title or clean_title(_first(info, "title") or stem)

    album, album_artist = _album_fields(path, info, artist=artist, channel=channel)

    tags: dict = {}
    if title:
        tags["title"] = title
    if artist:
        tags["artist"] = artist
    if album:
        tags["album"] = album
    # Never leave this empty when there is anything to group — a missing album
    # artist is exactly what makes Plex say "Various Artists".
    if album_artist and (artist or album):
        tags["album_artist"] = album_artist

    date = _year(info)
    if date:
        tags["date"] = date

    genre = _first(info, "genre")
    if genre:
        tags["genre"] = genre

    index = info.get("playlist_index")
    if isinstance(index, int) and index > 0:
        tags["track_number"] = index
        count = info.get("playlist_count")
        if isinstance(count, int) and count > 0:
            tags["track_total"] = count

    return tags
