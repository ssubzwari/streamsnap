"""Music tags for audio downloads: deriving them from yt-dlp metadata and the
file name, and writing them into each container mutagen supports."""

import pytest

from app.ytdl import tagging, trackinfo


# ── Title / artist parsing ────────────────────────────────────────────────────

def test_clean_title_strips_upload_noise():
    assert trackinfo.clean_title("Creep (Official Music Video)") == "Creep"
    assert trackinfo.clean_title("Creep [HD]") == "Creep"
    assert trackinfo.clean_title("Creep (Lyrics)") == "Creep"
    assert trackinfo.clean_title("Creep (1993)") == "Creep"
    assert trackinfo.clean_title("Creep - Official Audio") == "Creep"
    assert trackinfo.clean_title("Creep") == "Creep"


def test_split_artist_title():
    assert trackinfo.split_artist_title("Radiohead - Creep") == ("Radiohead", "Creep")
    assert trackinfo.split_artist_title("Radiohead – Creep (Official Video)") == (
        "Radiohead", "Creep"
    )
    assert trackinfo.split_artist_title("Radiohead | Creep") == ("Radiohead", "Creep")


def test_split_keeps_hyphenated_names_intact():
    """Only a separator with spaces around it splits, so hyphenated artist and
    track names survive."""
    assert trackinfo.split_artist_title("Jay-Z") == (None, "Jay-Z")
    assert trackinfo.split_artist_title("Blink-182 - Dammit") == ("Blink-182", "Dammit")
    assert trackinfo.split_artist_title("Spider-Man Theme") == (None, "Spider-Man Theme")


def test_strip_topic_suffix():
    assert trackinfo.strip_topic("Radiohead - Topic") == "Radiohead"
    assert trackinfo.strip_topic("Radiohead") == "Radiohead"
    assert trackinfo.strip_topic(None) is None


# ── Tag derivation ────────────────────────────────────────────────────────────

def test_ytdlp_metadata_wins_over_the_file_name():
    """YouTube Music supplies real fields — prefer them to a parsed name."""
    tags = trackinfo.derive_tags(
        "/music/Radiohead/Some Sloppy Upload Name.m4a",
        {
            "artist": "Radiohead",
            "track": "Creep",
            "album": "Pablo Honey",
            "release_year": 1993,
            "uploader": "Radiohead - Topic",
        },
    )
    assert tags["artist"] == "Radiohead"
    assert tags["title"] == "Creep"
    assert tags["album"] == "Pablo Honey"
    assert tags["date"] == "1993"


def test_file_name_is_parsed_when_the_site_gives_nothing():
    """An ordinary YouTube video has no artist field — the name carries it."""
    tags = trackinfo.derive_tags(
        "/music/Mix/Radiohead - Creep (Official Video).mp3", {"title": "whatever"}
    )
    assert tags["artist"] == "Radiohead"
    assert tags["title"] == "Creep"


def test_album_artist_is_always_set_alongside_an_artist():
    """A missing album artist is what makes Plex say "Various Artists", so an
    artist without one must never be produced."""
    tags = trackinfo.derive_tags("/music/Mix/Radiohead - Creep.opus", {})
    assert tags["artist"] == "Radiohead"
    assert tags["album_artist"] == "Radiohead"


def test_album_artist_falls_back_to_the_channel():
    """No separator in the name and no artist field — the channel still gives
    the folder one consistent artist."""
    tags = trackinfo.derive_tags(
        "/music/Lofi Beats/Study Session 4.m4a",
        {"uploader": "Lofi Girl - Topic"},
    )
    assert tags["artist"] == "Lofi Girl"
    assert tags["album_artist"] == "Lofi Girl"
    assert tags["title"] == "Study Session 4"


def test_explicit_album_artist_is_respected():
    tags = trackinfo.derive_tags(
        "/music/Mix/Jack White - Another Way.m4a",
        {"artist": "Jack White", "album_artist": "Various Artists Soundtrack"},
    )
    assert tags["artist"] == "Jack White"
    assert tags["album_artist"] == "Various Artists Soundtrack"


def test_album_falls_back_to_the_playlist_then_the_folder():
    from_playlist = trackinfo.derive_tags(
        "/music/Show/Ep 1.m4a", {"playlist_title": "Live Sessions"}
    )
    assert from_playlist["album"] == "Live Sessions"

    from_folder = trackinfo.derive_tags("/music/Live Sessions/Ep 1.m4a", {})
    assert from_folder["album"] == "Live Sessions"


def test_track_number_comes_from_the_playlist_position():
    tags = trackinfo.derive_tags(
        "/music/Album/Track.m4a", {"playlist_index": 3, "playlist_count": 12}
    )
    assert tags["track_number"] == 3
    assert tags["track_total"] == 12


def test_playlist_index_is_ignored_when_absent_or_zero():
    assert "track_number" not in trackinfo.derive_tags("/m/a.m4a", {})
    assert "track_number" not in trackinfo.derive_tags("/m/a.m4a", {"playlist_index": 0})


def test_artists_list_is_flattened():
    """Newer yt-dlp returns `artists` as a list."""
    tags = trackinfo.derive_tags(
        "/m/a.m4a", {"artists": ["Calvin Harris", "Dua Lipa"], "track": "One Kiss"}
    )
    assert tags["artist"] == "Calvin Harris, Dua Lipa"
    assert tags["album_artist"] == "Calvin Harris, Dua Lipa"


def test_year_falls_back_to_the_upload_date():
    assert trackinfo.derive_tags("/m/a.m4a", {"upload_date": "20240115"})["date"] == "2024"
    assert trackinfo.derive_tags("/m/a.m4a", {"release_date": "19930222"})["date"] == "1993"


def test_derive_tags_works_with_no_metadata_at_all():
    tags = trackinfo.derive_tags("/music/Mix/Radiohead - Creep.flac")
    assert tags["artist"] == "Radiohead"
    assert tags["title"] == "Creep"
    assert tags["album"] == "Mix"


# ── Tag writing ───────────────────────────────────────────────────────────────

def _silent_mp3(path) -> str:
    """A minimal but valid MPEG-1 Layer III file.

    Built by hand rather than with ffmpeg so the suite stays dependency-free:
    40 frames of 128 kbps / 44.1 kHz silence is enough for mutagen to parse the
    stream and attach an ID3 tag.
    """
    frame = bytes([0xFF, 0xFB, 0x90, 0xC4]) + b"\x00" * 413
    path.write_bytes(frame * 40)
    return str(path)


TAGS = {
    "title": "Creep",
    "artist": "Radiohead",
    "album": "Pablo Honey",
    "album_artist": "Radiohead",
    "date": "1993",
    "genre": "alternative rock",
    "track_number": 2,
    "track_total": 12,
}


def test_write_tags_round_trips_through_id3(tmp_path):
    from mutagen.mp3 import MP3

    path = _silent_mp3(tmp_path / "track.mp3")
    tagging.write_tags(path, TAGS)

    id3 = MP3(path).tags
    assert id3["TIT2"].text == ["Creep"]
    assert id3["TPE1"].text == ["Radiohead"]
    assert id3["TALB"].text == ["Pablo Honey"]
    assert id3["TPE2"].text == ["Radiohead"]   # album artist — the Plex fix
    assert id3["TDRC"].text[0].text == "1993"
    assert id3["TCON"].text == ["alternative rock"]
    assert id3["TRCK"].text == ["2/12"]


def test_write_tags_is_idempotent(tmp_path):
    """Re-downloading over a tagged file replaces values instead of stacking
    duplicate frames."""
    from mutagen.mp3 import MP3

    path = _silent_mp3(tmp_path / "track.mp3")
    tagging.write_tags(path, TAGS)
    tagging.write_tags(path, {**TAGS, "title": "Creep (Acoustic)"})

    id3 = MP3(path).tags
    assert id3["TIT2"].text == ["Creep (Acoustic)"]
    assert len(id3.getall("TIT2")) == 1
    assert len(id3.getall("TPE2")) == 1


def test_track_number_without_a_total():
    assert tagging._track_pair({"track_number": 5}) == "5"
    assert tagging._track_pair({"track_number": 5, "track_total": 9}) == "5/9"


def test_vorbis_field_names():
    fields = tagging._vorbis_fields(TAGS)
    assert fields["TITLE"] == "Creep"
    assert fields["ARTIST"] == "Radiohead"
    assert fields["ALBUMARTIST"] == "Radiohead"
    assert fields["TRACKNUMBER"] == "2"
    assert fields["TRACKTOTAL"] == "12"


def test_can_tag_accepts_audio_containers_only():
    assert tagging.can_tag("song.m4a")
    assert tagging.can_tag("song.FLAC")
    assert not tagging.can_tag("video.mkv")
    assert not tagging.can_tag("video.webm")
    assert not tagging.can_tag(None)


def test_write_tags_rejects_an_unsupported_container(tmp_path):
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"")
    with pytest.raises(tagging.TaggingError, match="unsupported container"):
        tagging.write_tags(str(path), TAGS)


def test_write_tags_rejects_an_empty_tag_set(tmp_path):
    path = _silent_mp3(tmp_path / "track.mp3")
    with pytest.raises(tagging.TaggingError, match="no tags"):
        tagging.write_tags(path, {})


def test_write_tags_wraps_a_mutagen_failure(tmp_path):
    """A corrupt file surfaces as TaggingError so the download still succeeds."""
    path = tmp_path / "broken.mp3"
    path.write_bytes(b"not an mp3")
    with pytest.raises(tagging.TaggingError):
        tagging.write_tags(str(path), TAGS)


# ── Download hook ─────────────────────────────────────────────────────────────

def test_video_downloads_are_not_tagged(tmp_path):
    """The hook runs for every download; only audio should be touched."""
    from app.ytdl.service import _tag_audio_file

    path = tmp_path / "movie.mkv"
    path.write_bytes(b"not really a video")
    before = path.read_bytes()

    _tag_audio_file(str(path), {"artist": "Someone", "track": "Something"})

    assert path.read_bytes() == before


def test_a_broken_file_does_not_fail_the_download(tmp_path):
    """Tagging is the last step of run_download — it must never raise, or a
    finished download would be reported as failed."""
    from app.ytdl.service import _tag_audio_file

    path = tmp_path / "Radiohead - Creep.mp3"
    path.write_bytes(b"truncated garbage")

    _tag_audio_file(str(path), {})   # must not raise


def test_the_hook_tags_a_real_audio_file(tmp_path):
    from mutagen.mp3 import MP3

    from app.ytdl.service import _tag_audio_file

    path = _silent_mp3(tmp_path / "Radiohead - Creep.mp3")
    _tag_audio_file(path, {"album": "Pablo Honey", "release_year": 1993})

    id3 = MP3(path).tags
    assert id3["TPE1"].text == ["Radiohead"]
    assert id3["TPE2"].text == ["Radiohead"]
    assert id3["TIT2"].text == ["Creep"]
    assert id3["TALB"].text == ["Pablo Honey"]
