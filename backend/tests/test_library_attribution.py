"""Files found on disk are grouped with the subscription whose folder holds them.

A download started by a subscription carries its ``subscription_id``, and the
Dashboard groups on that column. Files imported by hand or picked up by a
rescan had no such link, so episodes sitting in the *same folder* as the rest
of a show were listed under "Other Completed Downloads" rather than with the
show — which is what the user sees on disk and does not match the UI.

The folder is what both have in common, so that is what these match on.
"""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import get_sessionmaker
from app.main import app
from app.models import Download, Subscription


def _reset() -> None:
    async def run() -> None:
        from sqlalchemy import delete

        S = get_sessionmaker()
        async with S() as s:
            await s.execute(delete(Download))
            await s.execute(delete(Subscription))
            await s.commit()

    asyncio.run(run())


def _add_subscription(title: str, folder: str) -> int:
    async def run() -> int:
        S = get_sessionmaker()
        async with S() as s:
            sub = Subscription(
                url=f"https://youtube.com/playlist?list={title}",
                title=title,
                download_dir=folder,
                check_interval_minutes=60,
            )
            s.add(sub)
            await s.flush()
            sub_id = sub.id
            await s.commit()
            return sub_id

    return asyncio.run(run())


def _row(**kw) -> int:
    async def run() -> int:
        S = get_sessionmaker()
        async with S() as s:
            d = Download(status="completed", percent=100.0, **kw)
            s.add(d)
            await s.flush()
            did = d.id
            await s.commit()
            return did

    return asyncio.run(run())


def _make_file(path: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"\0" * 16)
    return path


@pytest.fixture
def root(tmp_path, monkeypatch):
    """Point DOWNLOAD_DIR at a scratch folder for the duration of a test."""
    monkeypatch.setattr(settings, "DOWNLOAD_DIR", str(tmp_path))
    _reset()
    yield str(tmp_path)
    _reset()


# ── The reported bug ──────────────────────────────────────────────────────────

def test_imported_files_join_the_subscription_that_owns_their_folder(root):
    show = os.path.join(root, "Dar-e-Najaat")
    sub_id = _add_subscription("Dar-e-Najaat", show)
    _make_file(os.path.join(show, "Episode 27.mp4"))

    with TestClient(app) as c:
        r = c.post("/api/library/import", json={"paths": ["Dar-e-Najaat/Episode 27.mp4"]})
        assert r.status_code == 200, r.text
        assert r.json()["created"], r.json()

        grouped = c.get("/api/downloads/grouped").json()

    titles = {g["subscription_title"]: g for g in grouped["by_subscription"]}
    assert "Dar-e-Najaat" in titles
    assert titles["Dar-e-Najaat"]["download_count"] == 1
    assert grouped["manual_downloads"] == [], "it should not be an 'Other' download"
    assert titles["Dar-e-Najaat"]["downloads"][0]["subscription_id"] == sub_id


def test_rescan_rehomes_files_that_were_already_imported(root):
    """The 27 episodes already sitting in "Other" must not need re-importing."""
    show = os.path.join(root, "Dar-e-Najaat")
    sub_id = _add_subscription("Dar-e-Najaat", show)

    stranded = [
        _row(
            url=f"file://{_make_file(os.path.join(show, f'Episode {n}.mp4'))}",
            title=f"Episode {n}",
            output_dir=show,
            output_path=os.path.join(show, f"Episode {n}.mp4"),
        )
        for n in (20, 21, 22)
    ]

    with TestClient(app) as c:
        before = c.get("/api/downloads/grouped").json()
        assert len(before["manual_downloads"]) == 3

        report = c.post("/api/library/rescan").json()
        assert {a["id"] for a in report["attributed"]} == set(stranded)

        after = c.get("/api/downloads/grouped").json()

    assert after["manual_downloads"] == []
    [group] = after["by_subscription"]
    assert group["subscription_id"] == sub_id
    assert group["download_count"] == 3


def test_episodes_in_the_same_folder_end_up_in_one_group(root):
    """The screenshot case: some episodes subscribed, some imported, one folder."""
    show = os.path.join(root, "Dar-e-Najaat")
    sub_id = _add_subscription("Dar-e-Najaat", show)

    for n in (30, 31):  # arrived through the subscription
        _row(
            url=f"https://youtu.be/e{n}", title=f"Episode {n}", subscription_id=sub_id,
            output_dir=show, output_path=_make_file(os.path.join(show, f"Episode {n}.mp4")),
        )
    for n in (28, 29):  # found on disk
        _row(
            url=f"file://e{n}", title=f"Episode {n}",
            output_dir=show, output_path=_make_file(os.path.join(show, f"Episode {n}.mp4")),
        )

    with TestClient(app) as c:
        c.post("/api/library/rescan")
        grouped = c.get("/api/downloads/grouped").json()

    assert grouped["manual_downloads"] == []
    [group] = grouped["by_subscription"]
    assert group["download_count"] == 4


# ── Not over-reaching ─────────────────────────────────────────────────────────

def test_files_outside_any_subscription_folder_stay_manual(root):
    _add_subscription("Dar-e-Najaat", os.path.join(root, "Dar-e-Najaat"))
    _make_file(os.path.join(root, "Random", "Some Clip.mp4"))

    with TestClient(app) as c:
        c.post("/api/library/import", json={"paths": ["Random/Some Clip.mp4"]})
        grouped = c.get("/api/downloads/grouped").json()

    assert len(grouped["manual_downloads"]) == 1
    assert grouped["by_subscription"] == []


def test_a_folder_two_subscriptions_share_is_left_alone(root):
    """There is no right answer, and guessing files the episodes under the
    wrong show — worse than leaving them in 'Other'."""
    shared = os.path.join(root, "Shared")
    _add_subscription("Show A", shared)
    _add_subscription("Show B", shared)
    _make_file(os.path.join(shared, "Episode 1.mp4"))

    with TestClient(app) as c:
        c.post("/api/library/import", json={"paths": ["Shared/Episode 1.mp4"]})
        grouped = c.get("/api/downloads/grouped").json()

    assert len(grouped["manual_downloads"]) == 1


def test_a_nested_subscription_folder_wins_over_its_parent(root):
    """Deepest match, so a show inside another show's folder keeps its own
    episodes."""
    outer = os.path.join(root, "Dramas")
    inner = os.path.join(outer, "Dar-e-Najaat")
    _add_subscription("All Dramas", outer)
    inner_id = _add_subscription("Dar-e-Najaat", inner)
    _make_file(os.path.join(inner, "Episode 1.mp4"))

    with TestClient(app) as c:
        c.post("/api/library/import", json={"paths": ["Dramas/Dar-e-Najaat/Episode 1.mp4"]})
        grouped = c.get("/api/downloads/grouped").json()

    rows = [d for g in grouped["by_subscription"] for d in g["downloads"]]
    assert len(rows) == 1
    assert rows[0]["subscription_id"] == inner_id


def test_an_existing_subscription_link_is_never_overwritten(root):
    """Only rows with no subscription are filled in; a deliberate assignment
    stands."""
    show = os.path.join(root, "Dar-e-Najaat")
    _add_subscription("Dar-e-Najaat", show)
    other_id = _add_subscription("Other Show", os.path.join(root, "Other Show"))

    did = _row(
        url="https://youtu.be/x", title="Episode 1", subscription_id=other_id,
        output_dir=show, output_path=_make_file(os.path.join(show, "Episode 1.mp4")),
    )

    with TestClient(app) as c:
        report = c.post("/api/library/rescan").json()
        assert report["attributed"] == []
        rows = {d["id"]: d for d in c.get("/api/downloads").json()}

    assert rows[did]["subscription_id"] == other_id


def test_rescan_without_subscriptions_still_works(root):
    _make_file(os.path.join(root, "Clip.mp4"))
    with TestClient(app) as c:
        report = c.post("/api/library/rescan").json()
    assert report["attributed"] == []
    assert "Clip.mp4" in report["unlinked"]
