# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MetubePlus is a self-hosted video downloader web app wrapping [yt-dlp](https://github.com/yt-dlp/yt-dlp). It exposes yt-dlp's full configuration surface, supports playlist subscriptions with automatic polling, and delivers real-time download progress and notifications over WebSockets.

**Prerequisites (must be on PATH):** Python 3.11+, Node 20+, `yt-dlp`, `ffmpeg`

**Deployment target:** Local Windows only — no Docker, no compose. Backend runs via `uvicorn` in a Python venv; frontend via Vite dev server. Single-user, no auth (same model as MeTube — assumes private network).

## Commands

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows
pip install -e .
uvicorn app.main:app --reload --port 8088   # dev server → http://localhost:8088
```

```bash
# Tests
cd backend && pytest tests/

# Single test file
pytest tests/test_download_manager.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev    # Vite dev server → http://localhost:5173
```

The Vite dev server must proxy `/api` and `/socket.io` requests to `http://localhost:8088` — configure this in `vite.config.ts`.

## Architecture

```
React Frontend (Vite + TS)
   ↓ REST (fetch)   ↓ Socket.IO
FastAPI Application (port 8088)
├── Download Manager  (ProcessPoolExecutor — keeps yt-dlp off asyncio loop)
├── Subscription Worker  (APScheduler AsyncIOScheduler)
├── Notification Dispatcher
└── Routes: /api/downloads  /api/subscriptions  /api/metadata  /api/settings  /api/notifications
      ↓
SQLite via SQLAlchemy 2.x (async)
      ↓
yt-dlp  (YoutubeDL class, not subprocess)
```

**Key design decisions:**
- Downloads run in a `ProcessPoolExecutor` to avoid blocking the asyncio event loop and to sidestep GIL contention across concurrent downloads.
- yt-dlp is used as a Python library (`YoutubeDL` class). Progress comes from `progress_hooks` callbacks, not stdout parsing.
- `python-socketio` is mounted on FastAPI for WebSocket events. The client uses `socket.io-client`.
- Subscription deduplication uses a `seen_videos` table with a `UNIQUE(subscription_id, video_id)` constraint. yt-dlp's `--download-archive` is available as a secondary guard.
- SQLite only — single-file, zero ops, fits the single-user deployment model.
- Frontend state: `useReducer` reducers colocated in `frontend/src/pages/Dashboard/index.tsx` (downloads, subscriptions); theme via `ThemeContext`. No global store library.

## Key Files

| File | Purpose |
|---|---|
| `backend/app/main.py` | FastAPI + socketio app factory, lifespan startup/shutdown |
| `backend/app/config.py` | Pydantic settings, `.env` loading |
| `backend/app/db.py` | Async SQLAlchemy engine, session dependency, `init_db()`, `SCHEMA_VERSION`, migration registry |
| `backend/app/models.py` | ORM: `Download`, `Subscription`, `SeenVideo`, `Notification`, `Setting`, `NotificationChannel` |
| `backend/app/schemas.py` | Pydantic request/response DTOs |
| `backend/app/events.py` | WebSocket event name constants + payload dataclasses |
| `backend/app/ws.py` | socketio server instance, room helpers |
| `backend/app/ytdl/service.py` | `YoutubeDL` wrapper — `extract_metadata()` and `download()` |
| `backend/app/ytdl/progress.py` | `progress_hook` → throttled WebSocket event adapter |
| `backend/app/services/download_manager.py` | Queue, ProcessPoolExecutor, cancellation tokens |
| `backend/app/services/subscription_worker.py` | APScheduler job: flat-playlist extraction → set diff → enqueue |
| `backend/app/ytdl/artwork.py` | Fetch first-video thumbnail → `poster.jpg` + `background.jpg` (Plex/Jellyfin) |
| `frontend/src/ws/socket.ts` | socket.io-client singleton |
| `frontend/src/styles/tokens.css` | All design tokens (colors + per-theme elevation, spacing, radii, typography, motion) |
| `frontend/src/theme/ThemeContext.tsx` | `mode` (dark/light) + `background` id, persisted to `localStorage` |
| `frontend/src/theme/Background.tsx` | Mounts the chosen background; lazy-loads three.js only for Vanta effects; `paused` prop stops it when a modal covers the page |
| `frontend/src/theme/customEffects.ts` | 10 dependency-free canvas backgrounds on a shared 30fps rAF driver (auto-stops on tab-hidden / pause / reduced-motion) |

## WebSocket Events

| Event | Direction | Trigger |
|---|---|---|
| `download:added` | server→client | Download enqueued |
| `download:updated` | server→client | Progress tick (~2/sec, throttled) |
| `download:completed` | server→client | Download finished |
| `download:failed` | server→client | Worker exception |
| `download:canceled` | server→client | User cancels |
| `downloads:paused` | server→client | Queue paused/resumed — manual "Pause all" or automatic bot-check pause |
| `subscription:checked` | server→client | APScheduler poll completes |
| `subscription:new_video` | server→client | New video detected in playlist (fires before auto-download enqueues) |
| `notification:created` | server→client | Any notification (drives toast UI) |

## Data Model

| Table | Key columns |
|---|---|
| `downloads` | id, url, title, status (`queued/downloading/completed/failed/canceled`), percent, speed, eta, format_spec, output_dir, output_path, error_message, subscription_id FK, ext, filesize, height, vcodec, acodec, category/subcategory/tag |
| `subscriptions` | id, url, title, check_interval_minutes, last_checked_at, format_spec, output_template, is_active, download_existing, download_dir, notify, category/subcategory/tag |
| `seen_videos` | id, subscription_id FK, video_id, title, upload_date — UNIQUE(subscription_id, video_id) |
| `notifications` | id, kind, title, body, payload_json, is_read, created_at |
| `settings` | key/value store for app-wide yt-dlp defaults + internal `schema_version` key |

## Schema Versioning

`SCHEMA_VERSION` in `backend/app/db.py` is an integer constant. `init_db()` runs at every startup and:
1. Calls `create_all()` to create any missing tables
2. Reads `schema_version` from the `settings` table
3. Bootstraps new DBs (version 0, run all migrations) vs existing pre-versioning DBs (version 1, already migrated)
4. Runs any pending `_migrate_vN` functions in order, writing the version after each one

**To add a migration:** write `async def _migrate_v2(conn)`, append to `_MIGRATIONS`, set `SCHEMA_VERSION = 2`. The loop handles the rest.

The current schema version is exposed at `GET /api/settings/db/schema-version` and displayed in Settings → Advanced → Database.

## Subscription Flow

`POST /api/subscriptions` accepts a `download_existing: bool` flag (default `false`).

- **`false` (default):** Backfill all current video IDs into `seen_videos` immediately — enqueue nothing. Only future uploads trigger downloads.
- **`true`:** Backfill into `seen_videos` AND enqueue a `Download` row for each existing video.

On each APScheduler tick: re-extract flat playlist → set-diff against `seen_videos` → insert new rows → emit `subscription:new_video` + `notification:created` → enqueue downloads.

## Settings UI Tabs

Tab order: **Theme, Format, Subtitles, Metadata, Post-processing, Download, Output, Auth, Advanced, Notifications** (`TABS` in `frontend/src/pages/Settings/index.tsx`).

| Tab | Surface |
|---|---|
| **Theme** | page mode (dark/light) + animated background picker (None / 5 Vanta WebGL / 10 canvas effects); persisted to `localStorage` via `ThemeContext` |
| **Format** | format spec field + presets, quality cap (height), prefer codec (vp9/av1/h264), audio codec (opus/aac/m4a), merge container (mp4/mkv/webm), `--prefer-free-formats`, `--format-sort` |
| **Subtitles** | write subs, sub langs (multi-select), write auto subs, embed subs, convert subs format |
| **Metadata & Thumbnails** | embed thumbnail, write thumbnail, write info json, write description, embed metadata, embed chapters, subscription artwork (`poster.jpg` + `background.jpg` per show) |
| **Post-processing** | SponsorBlock remove categories, ffmpeg location, keep-video toggle |
| **Download** | concurrent downloads (live-applied via `download_manager.set_concurrency`, default 1), concurrent fragments, retries, fragment retries, rate limit, socket timeout, continue partial, no-overwrites |
| **Output** | paths (temp/home), output template with variable reference, restrict filenames, "Fix existing files" → zero-pad episode numbers already on disk (`POST /api/downloads/pad-episodes`) |
| **Auth** | cookies-from-browser selector, username, password (server-side only) |
| **Advanced** | schema version display, yt-dlp updater, database admin (backup / download backup / upload & restore / restore / initialize), raw `YoutubeDL` options JSON |
| **Notifications** | per-event toggles, external channels (SMTP/Slack/Discord/Telegram/Pushover), periodic summary |

Format presets: **Best Quality** (`bestvideo+bestaudio/best`), **1080p mp4**, **720p mp4**, **Audio only m4a**, **Audio only opus**.

## Database Admin (Settings → Advanced)

- **Backup now** — hot SQLite `.backup()` API, safe while downloads run; saved to `./backups` locally
- **Download backup** — serves any existing backup file to the browser for local download (`GET /api/settings/db/backups/{name}/download`)
- **Upload & Restore** — upload a `.db` file from the user's machine (`POST /api/settings/db/backups/upload`), then restore it from the list
- **Restore** — replace the live DB with a server-side backup; disposes engine connections first (Windows file-lock safe)
- **Initialize DB** — wipe downloads / subscriptions / seen videos / notifications; preserves notification channels and settings

## Design System

Tokens live in `frontend/src/styles/tokens.css`. All values must come from tokens — no ad-hoc color, spacing, timing, or shadow values in component CSS.

- **Palette (dark):** bg `#0A0A0B`, surface `#141416`, surface-hi `#1C1C1F`, border `#26262A`, text `#F5F5F7`, text-muted `#A0A0A8`, accent `#7C5CFF`, success `#3FD97F`, warn `#FFB84C`, error `#FF5C5C`
- **Theming:** colours + elevation are redefined under `:root[data-theme='light']`; `ThemeContext` writes `data-theme` on `<html>`. Never give a colour its only definition outside `:root`.
- **Elevation:** `--shadow-card` (panels), `--shadow-pop` (modals/toast), `--edge-hi` (inset top highlight) — all theme-aware
- **Spacing:** 4px grid (`--space-1` through `--space-8`)
- **Radii:** sm 6px, md 10px, lg 16px
- **Font:** Plus Jakarta Sans (`@fontsource/plus-jakarta-sans`, self-hosted)
- **Motion:** Always `cubic-bezier(0.16, 1, 0.3, 1)` with `--dur-fast` (120ms), `--dur-base` (200ms), or `--dur-slow` (320ms). `global.css` collapses all motion under `prefers-reduced-motion: reduce`.
- Styling: CSS Modules only — no Tailwind, no CSS-in-JS
- **Responsive:** `Dashboard.module.css` breakpoints at 900px (input/format rows wrap) and 640px (tables → stacked cards; `data-label` on a `<td>` becomes its inline label; `.rowQueued` collapses queued downloads to one line). Body must never scroll horizontally.

## Animated Backgrounds (`frontend/src/theme/`)

- "None" + 15 backgrounds: `VantaEffectId` (net/waves/cells/dots/rings — WebGL, three.js) and `CustomEffectId` (10 canvas effects in `customEffects.ts`).
- **three.js is loaded on demand** — `Background.tsx` does `import("three")` only when a Vanta effect is chosen. Never add a static `import ... from "three"` (it would re-inflate the main bundle by ~157 kB gzip).
- Canvas effects share one rAF driver (`customEffects.ts`): 30 fps cap, auto-stops on `document.hidden`, on `setEffectsPaused(true)` (App passes `paused={settingsOpen}` to `<Background>`), and under `prefers-reduced-motion` (one static frame). New effects must use the exported `loop()` / `setupCanvas()` helpers, not their own `requestAnimationFrame`.
- Backdrop canvas DPR is capped at 1.5.

## Phased Implementation

- **Phase 1:** Backend scaffold + download manager + minimal frontend dashboard
- **Phase 2:** Subscriptions + APScheduler + Subscriptions page
- **Phase 3:** Full settings UI (yt-dlp's config surface) — now 10 tabs incl. Theme
- **Phase 4:** Design polish — skeletons, toasts, responsive breakpoints, mobile card layout, dark/light themes + animated backgrounds, panel elevation

See `plans/kind-wibbling-lake.md` for the full implementation plan.
