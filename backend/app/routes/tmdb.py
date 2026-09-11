"""TMDB lookup endpoints — used by the UI to verify the API key and to pin a
subscription to the right title when the automatic search guesses wrong."""

import asyncio

from fastapi import APIRouter, HTTPException, Query

from app.services import artwork_settings

router = APIRouter(prefix="/api/tmdb", tags=["tmdb"])


@router.get("/search")
async def search(
    query: str = Query(..., min_length=1),
    kind: str | None = Query(None, pattern="^(tv|movie)$"),
    limit: int = Query(10, ge=1, le=20),
) -> dict:
    """Search TMDB for *query*. Returns the candidate titles with poster
    thumbnails so the user can pick one and store its id on the subscription."""
    from app.ytdl.tmdb import TmdbError, _get_json, clean_title

    api_key, language = await artwork_settings.tmdb_config()
    if not api_key:
        raise HTTPException(status_code=400, detail="No TMDB API key configured")

    cleaned = clean_title(query)
    path = f"/search/{kind}" if kind else "/search/multi"
    try:
        data = await asyncio.to_thread(
            _get_json, path, api_key,
            query=cleaned, language=language, include_adult="false",
        )
    except TmdbError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    results = []
    for r in (data.get("results") or []):
        media = r.get("media_type") or kind
        if media not in ("tv", "movie"):
            continue
        date = r.get("first_air_date") or r.get("release_date") or ""
        results.append({
            "id": r["id"],
            "kind": media,
            "name": r.get("name") or r.get("title") or "",
            "year": date[:4] or None,
            "overview": (r.get("overview") or "")[:300],
            "poster": (
                f"https://image.tmdb.org/t/p/w154{r['poster_path']}"
                if r.get("poster_path") else None
            ),
        })
        if len(results) >= limit:
            break

    return {"query": cleaned, "results": results}


@router.get("/status")
async def status() -> dict:
    """Whether a usable TMDB key is configured, verified against TMDB."""
    from app.ytdl.tmdb import TmdbError, _get_json

    api_key, language = await artwork_settings.tmdb_config()
    if not api_key:
        return {"configured": False, "ok": False, "language": language, "error": None}

    try:
        await asyncio.to_thread(_get_json, "/configuration", api_key)
    except TmdbError as exc:
        return {"configured": True, "ok": False, "language": language, "error": str(exc)}

    return {"configured": True, "ok": True, "language": language, "error": None}
