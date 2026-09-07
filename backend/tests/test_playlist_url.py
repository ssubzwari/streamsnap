from app.ytdl.service import _normalize_playlist_url


def test_show_url_rewritten_to_playlist():
    got = _normalize_playlist_url(
        "https://www.youtube.com/show/VLPLdZNFVCDo_1f9yabYZvw5xj4LfXVw0aot?sbp=Kgt4QjhIaU1sRkU0QUAB"
    )
    assert got == "https://www.youtube.com/playlist?list=PLdZNFVCDo_1f9yabYZvw5xj4LfXVw0aot"


def test_plain_playlist_url_untouched():
    url = "https://www.youtube.com/playlist?list=PLbVdwtmx18stzXsA6ucMwP5EGeBJA-F-H"
    assert _normalize_playlist_url(url) == url


def test_channel_url_untouched():
    url = "https://www.youtube.com/@SomeChannel/videos"
    assert _normalize_playlist_url(url) == url
