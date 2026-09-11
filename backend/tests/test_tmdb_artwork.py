"""TMDB artwork: title cleaning, match ranking, image selection, and the
fallback to the first video's thumbnail when TMDB comes up empty."""

import os
import pathlib

import pytest

from app.ytdl import artwork, tmdb


# ── Title cleaning ────────────────────────────────────────────────────────────

def test_clean_title_strips_channel_noise():
    assert tmdb.clean_title("Breaking Bad - Official Channel") == "Breaking Bad"
    assert tmdb.clean_title("The Office - Season 3") == "The Office"
    assert tmdb.clean_title("Arcane (2021)") == "Arcane"
    assert tmdb.clean_title("Some Band - Topic") == "Some Band"
    # A clean title is left alone, and stripping never returns nothing.
    assert tmdb.clean_title("Severance") == "Severance"
    assert tmdb.clean_title("Official") == "Official"
    assert tmdb.clean_title("") == ""


# ── Match ranking ─────────────────────────────────────────────────────────────

def _stub_search(monkeypatch, results):
    def fake(path, api_key, **params):
        assert path == "/search/multi"
        return {"results": results}

    monkeypatch.setattr(tmdb, "_get_json", fake)


def test_search_prefers_exact_title_then_tv(monkeypatch):
    _stub_search(monkeypatch, [
        {"media_type": "movie", "id": 1, "title": "Severance", "popularity": 90.0,
         "release_date": "2015-01-01"},
        {"media_type": "tv", "id": 2, "name": "Severance", "popularity": 40.0,
         "first_air_date": "2022-02-18"},
        {"media_type": "tv", "id": 3, "name": "Severance Aftershow", "popularity": 99.0},
    ])
    match = tmdb.search_title("Severance", "key")
    # Exact name beats popularity; TV beats movie on an equal name.
    assert match == {"kind": "tv", "id": 2, "name": "Severance", "year": "2022"}


def test_search_ignores_people_and_empty_results(monkeypatch):
    _stub_search(monkeypatch, [{"media_type": "person", "id": 9, "name": "Someone"}])
    assert tmdb.search_title("Someone", "key") is None

    _stub_search(monkeypatch, [])
    assert tmdb.search_title("Nothing At All", "key") is None
    # No query at all never hits the network.
    assert tmdb.search_title("", "key") is None


# ── Image selection ───────────────────────────────────────────────────────────

def test_pick_prefers_language_for_posters():
    images = [
        {"file_path": "/de.jpg", "iso_639_1": "de", "vote_average": 9.0, "width": 2000},
        {"file_path": "/en.jpg", "iso_639_1": "en", "vote_average": 5.0, "width": 1000},
        {"file_path": "/none.jpg", "iso_639_1": None, "vote_average": 8.0, "width": 1500},
    ]
    assert tmdb._pick(images, "en")["file_path"] == "/en.jpg"


def test_pick_prefers_textless_for_backdrops():
    images = [
        {"file_path": "/en.jpg", "iso_639_1": "en", "vote_average": 9.0, "width": 3840},
        {"file_path": "/none.jpg", "iso_639_1": None, "vote_average": 4.0, "width": 1920},
    ]
    assert tmdb._pick(images, "en", prefer_textless=True)["file_path"] == "/none.jpg"


def test_pick_falls_back_to_rating_within_a_language():
    images = [
        {"file_path": "/low.jpg", "iso_639_1": "en", "vote_average": 2.0, "width": 4000},
        {"file_path": "/high.jpg", "iso_639_1": "en", "vote_average": 7.0, "width": 1000},
    ]
    assert tmdb._pick(images, "en")["file_path"] == "/high.jpg"
    assert tmdb._pick([], "en") is None


# ── Writing artwork ───────────────────────────────────────────────────────────

def _stub_images(monkeypatch, downloaded: list[str]):
    """Route every TMDB call to canned data and write a stub file instead of
    downloading, so the whole write path runs without network or ffmpeg."""
    def fake_get_json(path, api_key, **params):
        if path == "/search/multi":
            return {"results": [{"media_type": "tv", "id": 42, "name": "Show",
                                 "first_air_date": "2020-01-01", "popularity": 1.0}]}
        if path.endswith("/images"):
            return {
                "posters": [{"file_path": "/p.jpg", "iso_639_1": "en", "vote_average": 9.0}],
                "backdrops": [{"file_path": "/b.jpg", "iso_639_1": None, "vote_average": 9.0}],
                "logos": [{"file_path": "/l.png", "iso_639_1": "en", "vote_average": 9.0}],
            }
        if path == "/tv/42":
            return {"seasons": [
                {"season_number": 0, "poster_path": "/s0.jpg"},
                {"season_number": 1, "poster_path": "/s1.jpg"},
            ]}
        raise AssertionError(f"unexpected TMDB path {path}")

    def fake_download(url, dest):
        downloaded.append(url)
        with open(dest, "wb") as fh:
            fh.write(b"stub")
        return True

    monkeypatch.setattr(tmdb, "_get_json", fake_get_json)
    monkeypatch.setattr(tmdb, "_download", fake_download)
    # Derived crops need ffmpeg; exercise them separately.
    monkeypatch.setattr(tmdb, "_ffmpeg_crop", lambda *a, **k: False)


def test_fetch_tmdb_artwork_writes_every_name(monkeypatch, tmp_path):
    downloaded: list[str] = []
    _stub_images(monkeypatch, downloaded)

    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="key", title="Show")

    assert res["error"] is None
    assert res["matched"]["id"] == 42
    written = {os.path.basename(p) for p in res["written"]}
    assert written == {
        "poster.jpg", "background.jpg", "logo.png",
        "season-specials-poster.jpg", "season01-poster.jpg",
    }
    assert all(u.startswith(tmdb.IMAGE_BASE) for u in downloaded)


def test_fetch_tmdb_artwork_derives_square_and_banner(monkeypatch, tmp_path):
    downloaded: list[str] = []
    _stub_images(monkeypatch, downloaded)

    def fake_crop(src, dest, vf):
        with open(dest, "wb") as fh:
            fh.write(b"stub")
        return True

    monkeypatch.setattr(tmdb, "_ffmpeg_crop", fake_crop)
    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="key", title="Show")

    written = {os.path.basename(p) for p in res["written"]}
    assert "square.jpg" in written and "banner.jpg" in written


def test_fetch_tmdb_artwork_replaces_stale_formats(monkeypatch, tmp_path):
    _stub_images(monkeypatch, [])
    stale = tmp_path / "poster.webp"
    stale.write_bytes(b"old")

    tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="key", title="Show")

    assert not stale.exists()
    assert (tmp_path / "poster.jpg").exists()


def test_fetch_tmdb_artwork_needs_a_key(tmp_path):
    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="", title="Show")
    assert res["written"] == [] and "no TMDB API key" in res["error"]


def test_fetch_tmdb_artwork_reports_a_miss(monkeypatch, tmp_path):
    monkeypatch.setattr(tmdb, "_get_json", lambda *a, **k: {"results": []})
    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="key", title="Nope")
    assert res["matched"] is None and "no TMDB match" in res["error"]


def test_fetch_tmdb_artwork_survives_api_errors(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise tmdb.TmdbError("HTTP 401 Invalid API key")

    monkeypatch.setattr(tmdb, "_get_json", boom)
    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="bad", title="Show")
    assert res["written"] == [] and "401" in res["error"]


def test_pinned_id_skips_the_search(monkeypatch, tmp_path):
    calls: list[str] = []

    def fake_get_json(path, api_key, **params):
        calls.append(path)
        if path.endswith("/images"):
            return {"posters": [{"file_path": "/p.jpg", "iso_639_1": "en"}]}
        return {"seasons": []}

    monkeypatch.setattr(tmdb, "_get_json", fake_get_json)
    def fake_download(url, dest):
        pathlib.Path(dest).write_bytes(b"stub")
        return True

    monkeypatch.setattr(tmdb, "_download", fake_download)
    monkeypatch.setattr(tmdb, "_ffmpeg_crop", lambda *a, **k: False)

    res = tmdb.fetch_tmdb_artwork(str(tmp_path), api_key="key", title="Wrong Name",
                                  tmdb_id=99, tmdb_type="movie")

    assert "/search/multi" not in calls
    assert res["matched"]["id"] == 99 and res["matched"]["kind"] == "movie"
    assert calls[0] == "/movie/99/images"


# ── Orchestration / fallback ──────────────────────────────────────────────────

def test_subscription_artwork_prefers_tmdb(monkeypatch, tmp_path):
    monkeypatch.setattr(
        artwork, "fetch_playlist_artwork",
        lambda *a, **k: pytest.fail("thumbnail fallback should not run"),
    )
    monkeypatch.setattr(
        "app.ytdl.tmdb.fetch_tmdb_artwork",
        lambda folder, **k: {"matched": {"id": 7}, "written": ["poster.jpg"], "error": None},
    )

    out = artwork.fetch_subscription_artwork("https://v", str(tmp_path), title="Show",
                                             tmdb_api_key="key")
    assert out["source"] == "tmdb" and out["written"] == ["poster.jpg"]


def test_subscription_artwork_falls_back_to_thumbnail(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "app.ytdl.tmdb.fetch_tmdb_artwork",
        lambda folder, **k: {"matched": None, "written": [], "error": "no TMDB match"},
    )
    monkeypatch.setattr(artwork, "fetch_playlist_artwork",
                        lambda url, folder, **k: ["poster.jpg", "background.jpg"])

    out = artwork.fetch_subscription_artwork("https://v", str(tmp_path), title="Show",
                                             tmdb_api_key="key")
    assert out["source"] == "thumbnail" and out["error"] is None


def test_subscription_artwork_without_a_key_uses_the_thumbnail(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "app.ytdl.tmdb.fetch_tmdb_artwork",
        lambda folder, **k: pytest.fail("TMDB should not be called without a key"),
    )
    monkeypatch.setattr(artwork, "fetch_playlist_artwork", lambda url, folder, **k: ["poster.jpg"])

    out = artwork.fetch_subscription_artwork("https://v", str(tmp_path), title="Show")
    assert out["source"] == "thumbnail"


def test_subscription_artwork_reports_nothing_written(monkeypatch, tmp_path):
    monkeypatch.setattr(artwork, "fetch_playlist_artwork", lambda url, folder, **k: [])
    out = artwork.fetch_subscription_artwork("https://v", str(tmp_path))
    assert out["source"] is None and out["written"] == []


# ── API surface ───────────────────────────────────────────────────────────────

def test_tmdb_endpoints_need_a_key(monkeypatch):
    """Without a key, /search is a clean 400 and /status reports unconfigured —
    neither reaches out to TMDB."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import artwork_settings

    async def no_key() -> tuple[str, str]:
        return "", "en"

    monkeypatch.setattr(artwork_settings, "tmdb_config", no_key)

    with TestClient(app) as c:
        assert c.get("/api/tmdb/search", params={"query": "Severance"}).status_code == 400
        status = c.get("/api/tmdb/status").json()
        assert status == {"configured": False, "ok": False, "language": "en", "error": None}


def test_subscriptions_carry_the_tmdb_columns():
    """The v6 migration / create_all leaves tmdb_id + tmdb_type on the table so
    the pin survives a restart."""
    import asyncio

    from sqlalchemy import inspect

    from app.db import engine, init_db

    async def cols() -> set[str]:
        await init_db()
        async with engine.connect() as conn:
            return set(await conn.run_sync(
                lambda c: [col["name"] for col in inspect(c).get_columns("subscriptions")]
            ))

    assert {"tmdb_id", "tmdb_type"} <= asyncio.run(cols())


def test_tmdb_search_endpoint_shapes_results(monkeypatch):
    """With a key configured, /search cleans the query, drops non-title results
    and returns poster thumbnails for the picker."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import artwork_settings

    async def with_key() -> tuple[str, str]:
        return "key", "en"

    monkeypatch.setattr(artwork_settings, "tmdb_config", with_key)

    seen: dict = {}

    def fake_get_json(path, api_key, **params):
        seen.update(path=path, **params)
        return {"results": [
            {"media_type": "person", "id": 1, "name": "Someone"},
            {"media_type": "tv", "id": 2, "name": "The Office",
             "first_air_date": "2005-03-24", "overview": "Paper.",
             "poster_path": "/o.jpg"},
        ]}

    monkeypatch.setattr("app.ytdl.tmdb._get_json", fake_get_json)

    with TestClient(app) as c:
        body = c.get("/api/tmdb/search", params={"query": "The Office - Season 3"}).json()

    assert seen["path"] == "/search/multi" and seen["query"] == "The Office"
    assert body["results"] == [{
        "id": 2, "kind": "tv", "name": "The Office", "year": "2005",
        "overview": "Paper.", "poster": "https://image.tmdb.org/t/p/w154/o.jpg",
    }]
