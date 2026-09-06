from app.models import Download
from app.routes.downloads import _stream_media_type


def _dl(
    vcodec: str | None,
    acodec: str | None = "mp4a.40.2",
    format_spec: str | None = None,
) -> Download:
    return Download(url="x", vcodec=vcodec, acodec=acodec, format_spec=format_spec)


def test_audio_only_mp4_container_served_as_audio():
    # yt-dlp audio-only downloads often land in an .mp4 container that
    # mimetypes reports as video/mp4 — the browser then opens a <video>.
    assert _stream_media_type(_dl("none"), "/x/Song.mp4") == "audio/mp4"


def test_audio_only_webm_served_as_audio():
    assert _stream_media_type(_dl("none"), "/x/Song.webm") == "audio/webm"


def test_audio_only_m4a_and_mp3():
    assert _stream_media_type(_dl("none"), "/x/Song.m4a") == "audio/mp4"
    assert _stream_media_type(_dl("none"), "/x/Song.mp3") == "audio/mpeg"


def test_audio_only_unknown_ext_falls_back_to_audio():
    assert _stream_media_type(_dl("none"), "/x/Song.weirdext").startswith("audio/")


def test_video_download_keeps_video_type():
    assert _stream_media_type(_dl("avc1.640028"), "/x/Clip.mp4") == "video/mp4"


def test_video_download_mkv():
    got = _stream_media_type(_dl("vp9"), "/x/Clip.mkv")
    assert got in ("video/x-matroska", "video/mkv", "application/octet-stream")


def test_no_codec_recorded_but_audio_extension_served_as_audio():
    # Row skipped as "already on disk" — no vcodec, but the file is an .m4a.
    assert _stream_media_type(_dl(None), "/x/Song.m4a") == "audio/mp4"
    assert _stream_media_type(_dl(None), "/x/Song.opus") == "audio/ogg"


def test_no_codec_recorded_audio_format_spec_served_as_audio():
    dl = _dl(None, format_spec="bestaudio[ext=m4a]/bestaudio/best")
    assert _stream_media_type(dl, "/x/Song.mp4") == "audio/mp4"


def test_no_codec_recorded_video_extension_stays_video():
    assert _stream_media_type(_dl(None), "/x/Clip.mp4") == "video/mp4"
