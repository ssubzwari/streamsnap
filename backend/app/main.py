"""
FastAPI application factory.

IMPORTANT: uvicorn must target `socket_app`, not `app`, because python-socketio
wraps the FastAPI ASGI app rather than being mounted on it.

  uvicorn app.main:socket_app --reload
"""

import pathlib
import sys
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db import init_db
from app.routes import downloads, metadata, notifications, settings as settings_route, subscriptions
from app.services.download_manager import download_manager
from app.services.subscription_worker import start_scheduler, stop_scheduler
from app.ws import sio


@asynccontextmanager
async def lifespan(app: FastAPI):
    # If a dedicated yt-dlp directory is configured (Docker volume), prepend it
    # to sys.path so the package installed there takes priority over the image default.
    if settings.YTDLP_DIR:
        ytdlp_path = str(pathlib.Path(settings.YTDLP_DIR).resolve())
        pathlib.Path(ytdlp_path).mkdir(parents=True, exist_ok=True)
        if ytdlp_path not in sys.path:
            sys.path.insert(0, ytdlp_path)

    # Ensure download directory exists
    pathlib.Path(settings.DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)

    # Initialize DB tables
    await init_db()

    # Start download manager (thread pool + relay tasks)
    await download_manager.start()

    # Start APScheduler and register jobs for active subscriptions
    await start_scheduler()

    yield

    # Graceful shutdown
    await stop_scheduler()
    await download_manager.stop()


app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(metadata.router)
app.include_router(downloads.router)
app.include_router(subscriptions.router)
app.include_router(notifications.router)
app.include_router(settings_route.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# ── Serve built frontend (production / Docker) ────────────────────────────────
# The frontend/dist folder is only present after `npm run build` (or in Docker).
# In dev mode the Vite dev server handles everything — this block is a no-op.
_DIST = pathlib.Path(__file__).parent.parent / "frontend" / "dist"
if _DIST.exists():
    # Serve /assets, /vite.svg, etc. as static files
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="frontend-assets")

    # SPA catch-all: any path that didn't match an API route → index.html
    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        return FileResponse(_DIST / "index.html")


# socketio wraps the FastAPI ASGI app — uvicorn serves socket_app
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)
