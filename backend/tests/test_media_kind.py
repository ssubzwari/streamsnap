from app.utils import is_audio_only_format, is_audio_path


def test_is_audio_path():
    assert is_audio_path("/dl/Song.m4a")
    assert is_audio_path("/dl/Song.OPUS")
    assert is_audio_path("/dl/Song.mp3")
    assert not is_audio_path("/dl/Clip.mp4")
    assert not is_audio_path("/dl/Clip.mkv")
    assert not is_audio_path(None)
    assert not is_audio_path("")


def test_is_audio_only_format():
    # audio presets used by the app
    assert is_audio_only_format("bestaudio[ext=m4a]/bestaudio/best")
    assert is_audio_only_format("bestaudio/best")
    assert is_audio_only_format("ba/best")
    # video specs must not match
    assert not is_audio_only_format("bestvideo*+bestaudio/best")
    assert not is_audio_only_format("bestvideo[height<=1080]+bestaudio/best")
    assert not is_audio_only_format("best")
    assert not is_audio_only_format("")
    assert not is_audio_only_format(None)
