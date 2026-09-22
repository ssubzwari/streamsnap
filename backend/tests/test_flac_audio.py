"""FLAC audio downloads.

No major site serves FLAC — YouTube's audio streams are Opus or AAC — so it is
reached by converting with ffmpeg rather than by picking a format. These cover
when that conversion is triggered and where the converted file ends up.
"""

from app.utils import is_audio_only_format, is_audio_path
from app.ytdl.service import _audio_conversion_target, _converted_audio_path


# ── When conversion kicks in ──────────────────────────────────────────────────

def test_flac_in_the_format_spec_triggers_conversion():
    assert _audio_conversion_target("bestaudio[ext=flac]/bestaudio/best", None) == "flac"
    assert _audio_conversion_target("bestaudio[ext=FLAC]/bestaudio", None) == "flac"


def test_flac_as_the_app_default_triggers_conversion():
    """Settings → Format → Audio Codec, so subscriptions can use it too."""
    assert _audio_conversion_target("bestaudio/best", {"audio_codec": "flac"}) == "flac"


def test_mp3_in_the_format_spec_triggers_conversion():
    """Sites serve Opus or AAC, so an mp3 has to be re-encoded from one. Picking
    it in the dropdown is an explicit request for that."""
    assert _audio_conversion_target("bestaudio[ext=mp3]/bestaudio/best", None) == "mp3"


def test_opus_is_remuxed_out_of_its_webm_container():
    """YouTube serves Opus inside webm, so selecting it alone writes a .webm —
    an extension is_audio_path() rejects, which means the tagger skips the file
    and Plex won't scan it. The extract-audio step copies the stream into a
    .opus container; no re-encode."""
    assert _audio_conversion_target(
        "bestaudio[ext=opus]/bestaudio[ext=webm]/bestaudio", None
    ) == "opus"


def test_the_old_opus_preset_spec_still_resolves_to_opus():
    """`bestaudio[ext=webm]` is what the preset emitted before this fix, and it
    is still stored in existing subscriptions and settings rows."""
    assert _audio_conversion_target("bestaudio[ext=webm]/bestaudio", None) == "opus"


def test_a_webm_request_on_a_video_download_is_untouched():
    """Only audio-only specs get the opus treatment — a video download asking
    for webm means the video container."""
    assert _audio_conversion_target("bestvideo*[ext=webm]+bestaudio/best", None) is None


def test_natively_available_formats_are_left_to_the_format_spec():
    """m4a is a stream the site already serves in a usable container — selecting
    it must never invoke ffmpeg."""
    for spec in ("bestaudio[ext=m4a]/bestaudio", "bestaudio/best"):
        assert _audio_conversion_target(spec, None) is None


def test_only_flac_is_driven_by_the_app_wide_setting():
    """A stored mp3 default would re-encode every audio download — a quality
    loss nobody asked for. Per-download mp3 is explicit; a default is not."""
    for codec in ("auto", "opus", "aac", "m4a", "mp3", ""):
        assert _audio_conversion_target("bestaudio/best", {"audio_codec": codec}) is None


def test_video_downloads_are_never_converted():
    assert _audio_conversion_target("bestvideo*+bestaudio/best", None) is None
    assert _audio_conversion_target("", None) is None
    assert _audio_conversion_target(None, None) is None


# ── Where the converted file lands ────────────────────────────────────────────

def test_converted_path_points_at_the_file_that_now_exists(tmp_path):
    """yt-dlp reports the file it downloaded; the extract-audio step has since
    replaced it, so the row must follow the conversion."""
    flac = tmp_path / "Radiohead - Creep.flac"
    flac.write_bytes(b"")
    downloaded = str(tmp_path / "Radiohead - Creep.webm")

    assert _converted_audio_path(downloaded, "flac") == str(flac)


def test_converted_path_is_unchanged_when_the_source_was_already_flac(tmp_path):
    already = str(tmp_path / "track.flac")
    assert _converted_audio_path(already, "flac") == already


def test_converted_path_falls_back_when_conversion_produced_nothing(tmp_path):
    """ffmpeg missing or the convert failing leaves the original in place —
    keep pointing at it rather than at a file that was never written."""
    downloaded = str(tmp_path / "track.webm")
    assert _converted_audio_path(downloaded, "flac") == downloaded
    assert _converted_audio_path("", "flac") == ""


# ── The rest of the pipeline recognises FLAC ──────────────────────────────────

def test_the_flac_spec_is_recognised_as_audio_only():
    """Drives the "Audio" row label and makes /stream serve an audio player."""
    assert is_audio_only_format("bestaudio[ext=flac]/bestaudio/best")


def test_flac_files_are_treated_as_audio():
    """So the music tagger picks them up — it supports FLAC."""
    assert is_audio_path("/downloads/Mix/Radiohead - Creep.flac")


def test_webm_is_not_audio_but_opus_is():
    """The whole reason opus needs remuxing: `.webm` fails this check, so
    _tag_audio_file() returns early and the file reaches Plex with no artist or
    album on it. `.opus` passes."""
    from app.ytdl.tagging import can_tag

    assert not is_audio_path("/downloads/Mix/Radiohead - Creep.webm")
    assert is_audio_path("/downloads/Mix/Radiohead - Creep.opus")
    assert can_tag("/downloads/Mix/Radiohead - Creep.opus")


# ── The options run_download actually hands yt-dlp ────────────────────────────

class _FakeYDL:
    """Captures the options instead of downloading. Records them on the class so
    the test can read them back after run_download returns."""

    captured: dict = {}

    def __init__(self, opts):
        type(self).captured = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        return {"requested_downloads": [{"filepath": "/tmp/song.webm"}]}


def _run(monkeypatch, tmp_path, format_spec, settings=None):
    import queue as _queue
    import threading

    import yt_dlp

    from app.ytdl.service import run_download

    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)
    run_download(
        1, "http://example.com/v", format_spec, str(tmp_path),
        _queue.Queue(), threading.Event(), settings,
    )
    return _FakeYDL.captured


def test_run_download_adds_the_extract_audio_postprocessor(monkeypatch, tmp_path):
    opts = _run(monkeypatch, tmp_path, "bestaudio[ext=flac]/bestaudio/best")
    assert {"key": "FFmpegExtractAudio", "preferredcodec": "flac"} in opts["postprocessors"]


def test_run_download_adds_the_opus_postprocessor(monkeypatch, tmp_path):
    opts = _run(monkeypatch, tmp_path, "bestaudio[ext=opus]/bestaudio[ext=webm]/bestaudio")
    assert {"key": "FFmpegExtractAudio", "preferredcodec": "opus"} in opts["postprocessors"]


def test_run_download_leaves_other_audio_downloads_alone(monkeypatch, tmp_path):
    opts = _run(monkeypatch, tmp_path, "bestaudio[ext=m4a]/bestaudio")
    assert not opts.get("postprocessors")


def test_raw_options_json_still_overrides_the_postprocessor(monkeypatch, tmp_path):
    """Settings → Advanced documents raw JSON as "applied last, overrides
    everything", so it has to win over the conversion we inject."""
    opts = _run(
        monkeypatch, tmp_path, "bestaudio[ext=flac]/bestaudio/best",
        {"raw_options_json": '{"postprocessors": []}'},
    )
    assert opts["postprocessors"] == []
