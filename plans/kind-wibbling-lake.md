# StreamSnap — Implementation Plan

## Context

**Why this work is being done.** The user wants a premium, minimalist web application called "StreamSnap" that wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) with three major capabilities:

1. A rich UI that exposes **all** of yt-dlp's meaningful feature surface (format selection, codec filters, subtitles, metadata, thumbnails, post-processing, rate-limiting).
2. **Playlist subscriptions** — paste a playlist URL once, have the backend poll it on a schedule and auto-download only the new videos since last check.
3. **Real-time notifications** pushed over WebSockets when new videos are detected, downloads start, or downloads complete.

The design is inspired by [alexta69/metube](https://github.com/alexta69/metube), but StreamSnap differs in three material ways:
- MeTube intentionally restricts its UI-visible config; StreamSnap exposes the full yt-dlp surface.
- MeTube has subscription polling but **no notification layer** — it silently queues. StreamSnap treats notifications as a first-class feature.
- StreamSnap ships a React + Vite + TypeScript frontend with a premium design system, not MeTube's Angular UI.

**State of the working directory.** The project root is currently empty except for two Windows `.url` shortcut files pointing at the two upstream reference projects. This is a greenfield scaffold.

## Research Findings

From upstream exploration (both repos fetched via WebFetch):

**MeTube architecture** (for reference, not literal copying):
- Backend: aiohttp + python-socketio, yt-dlp imported as a library
- Downloads run in a separate `multiprocessing.Process`; progress streams through a `multiprocessing.Queue` and is broadcast over WebSocket
- State persists as JSON files via an `AtomicJsonStore` (StreamSnap will use **SQLite** instead, per user spec)
- WebSocket events: `added`, `updated`, `completed`, `canceled`, `cleared`
- Key files to borrow patterns from: `app/main.py`, `app/ytdl.py`, `app/subscriptions.py`, `app/dl_formats.py`

**yt-dlp integration strategy**:
- Use the `YoutubeDL` class from the `yt_dlp` Python package directly (not subprocess)
- Metadata-only fetch: `ydl.extract_info(url, download=False)` with `extract_flat='in_playlist'` for subscription polling
- Progress reporting: `progress_hooks` callback in the YoutubeDL constructor — this is the cleanest path to WebSocket events
- Default format spec: `bestvideo+bestaudio/best` (requires FFmpeg on the host)
- Deduplication for subscriptions: track seen video IDs in SQLite (clean, queryable); optionally also pass yt-dlp's `--download-archive` as a belt-and-suspenders check

## Recommended Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend | **Python 3.11+ / FastAPI** | yt-dlp IS Python — importing the library gives us full API access, progress hooks, and `extract_info()` without subprocess parsing. FastAPI gives us async HTTP + native WebSockets + automatic OpenAPI. |
| Real-time | **python-socketio** mounted on FastAPI | Auto-reconnect, rooms, typed events — matches MeTube's proven pattern. Alternatively FastAPI's native WebSockets, but socketio's UX is richer. |
| Scheduler | **APScheduler** (AsyncIOScheduler) | In-process, async-native, persists jobs in SQLite alongside the rest of the state. |
| Persistence | **SQLite + SQLAlchemy 2.x (async)** | User spec. Single-file DB, zero ops, fits single-user web UI perfectly. |
| Process pool | `concurrent.futures.ProcessPoolExecutor` | Keeps yt-dlp downloads off the asyncio loop. Multi-proc avoids GIL contention when handling multiple concurrent downloads. |
| Frontend | **React 18 + Vite + TypeScript** | User spec. |
| Styling | **CSS Modules + CSS custom properties** | User spec — no CSS-in-JS, no Tailwind. |
| Fonts | **Plus Jakarta Sans** via `@fontsource/plus-jakarta-sans` | User rejected Inter/Arial/system-ui; self-hosted avoids CDN dependency. |
| Socket client | **socket.io-client** | Pairs with backend choice. |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     React Frontend (Vite)                    │
│  Dashboard · Subscriptions · Settings · Notifications Toast  │
└───────────────┬──────────────────────────┬──────────────────┘
                │ REST (fetch)             │ Socket.IO
                ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     FastAPI Application                      │
│  /api/downloads  /api/subscriptions  /api/metadata  /api/... │
│                                                               │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ Download     │   │ Subscription │   │ Notification    │  │
│  │ Manager      │   │ Worker       │   │ Dispatcher      │  │
│  │ (Process     │   │ (APScheduler │   │ (fan-out to WS, │  │
│  │  Pool +      │◄──┤  +           │──►│  DB, future:    │  │
│  │  WS broadcast│   │  extract_info│   │  email/webhook) │  │
│  └──────┬───────┘   └──────┬───────┘   └─────────────────┘  │
│         │                  │                                 │
│         └────────┬─────────┘                                 │
│                  ▼                                            │
│         ┌────────────────┐                                   │
│         │ SQLite (async) │                                   │
│         │  downloads /   │                                   │
│         │  subscriptions │                                   │
│         │  seen_videos / │                                   │
│         │  notifications │                                   │
│         └────────────────┘                                   │
└──────────────────────────────────────────────────────────────┘
                  │
                  ▼
            yt-dlp library
            (YoutubeDL class)
```

## Planned Project Layout

```
StreamSnap/
├── backend/
│   ├── pyproject.toml
│   ├── alembic.ini                 # if we want migrations, otherwise SQLAlchemy create_all
│   ├── app/
│   │   ├── main.py                 # FastAPI + socketio app factory
│   │   ├── config.py               # pydantic-settings, .env loading
│   │   ├── db.py                   # async engine, session, init
│   │   ├── models.py               # ORM: Download, Subscription, SeenVideo, Notification, Setting
│   │   ├── schemas.py              # Pydantic request/response DTOs
│   │   ├── events.py               # WS event name constants + payload dataclasses
│   │   ├── ws.py                   # socketio server, room management
│   │   ├── ytdl/
│   │   │   ├── service.py          # YoutubeDL wrapper: extract, download
│   │   │   ├── formats.py          # format presets, codec whitelists
│   │   │   └── progress.py         # progress_hook → WS adapter
│   │   ├── services/
│   │   │   ├── download_manager.py # queue, process pool, cancellation
│   │   │   ├── subscription_worker.py # APScheduler job: poll → diff → enqueue
│   │   │   └── notifications.py    # dispatcher
│   │   └── routes/
│   │       ├── downloads.py        # POST/GET/DELETE /api/downloads
│   │       ├── subscriptions.py    # CRUD + manual check trigger
│   │       ├── metadata.py         # POST /api/metadata/resolve
│   │       ├── settings.py         # GET/PUT app settings
│   │       └── notifications.py    # GET/mark-read
│   └── tests/
│       ├── test_download_manager.py
│       ├── test_subscription_worker.py
│       └── test_routes.py
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── router.tsx
│       ├── api/                    # typed REST wrappers
│       │   ├── client.ts
│       │   ├── downloads.ts
│       │   ├── subscriptions.ts
│       │   └── metadata.ts
│       ├── ws/
│       │   ├── socket.ts           # socket.io-client singleton
│       │   └── events.ts           # shared event type contracts
│       ├── hooks/
│       │   ├── useDownloads.ts
│       │   ├── useSubscriptions.ts
│       │   └── useLiveProgress.ts  # subscribes to ws + updates store
│       ├── store/                  # zustand or useReducer-based store
│       ├── components/
│       │   ├── DownloadRow/
│       │   ├── ProgressBar/
│       │   ├── FormatPicker/
│       │   ├── SubscriptionCard/
│       │   ├── SkeletonLoader/
│       │   ├── Toast/
│       │   └── EmptyState/
│       ├── pages/
│       │   ├── Dashboard/          # active + recent downloads
│       │   ├── Subscriptions/      # list, add, configure, manual-check
│       │   └── Settings/           # full yt-dlp config surface
│       ├── styles/
│       │   ├── tokens.css          # CSS custom properties
│       │   ├── reset.css
│       │   └── global.css
│       └── lib/
└── README.md
```

## Data Model (SQLite)

| Table | Key columns |
|---|---|
| `downloads` | id, url, title, status (queued/downloading/completed/failed/canceled), percent, speed, eta, format_spec, output_path, error_message, subscription_id (FK, nullable), created_at, updated_at |
| `subscriptions` | id, url, title, check_interval_minutes, last_checked_at, format_spec, output_template, is_active, created_at |
| `seen_videos` | id, subscription_id (FK), video_id, title, upload_date, detected_at — **UNIQUE(subscription_id, video_id)** |
| `notifications` | id, kind (new_video/download_complete/download_failed/subscription_error), title, body, payload_json, is_read, created_at |
| `settings` | k/v or single-row blob for app-wide yt-dlp defaults |

## WebSocket Event Model

Inspired by MeTube's `added/updated/completed/canceled` plus StreamSnap-specific additions:

| Event | Payload | When |
|---|---|---|
| `download:added` | DownloadInfo | POST /api/downloads or subscription worker enqueues |
| `download:updated` | { id, percent, speed, eta, status } | progress_hook tick (throttled to ~2/sec) |
| `download:completed` | DownloadInfo | progress_hook status=finished |
| `download:failed` | { id, error } | exception in worker |
| `download:canceled` | { id } | user cancels |
| `subscription:checked` | { id, new_count, last_checked_at } | APScheduler job completes |
| `subscription:new_video` | { subscription_id, video } | **StreamSnap-specific** — fires before the auto-download enqueues |
| `notification:created` | NotificationInfo | any notification — drives toast UI |

## yt-dlp Configuration Surface (Settings UI tabs)

| Tab | Options surfaced |
|---|---|
| **Format** | format spec field with presets, quality cap (height), prefer codec (vp9/av1/h264), audio codec (opus/aac/m4a), merge container (mp4/mkv/webm), `--prefer-free-formats` toggle, `--format-sort` advanced |
| **Subtitles** | write subs, sub langs (multi-select), write auto subs, embed subs, convert subs format |
| **Metadata & Thumbnails** | embed thumbnail, write thumbnail, write info json, write description, embed metadata, embed chapters |
| **Post-processing** | SponsorBlock remove categories (sponsor/intro/outro/selfpromo/music_offtopic/filler), ffmpeg location, keep-video toggle |
| **Download** | concurrent fragments, retries, fragment retries, rate limit, socket timeout, continue partial, no-overwrites |
| **Output** | paths (temp/home), output template with variable reference, restrict filenames |
| **Auth** | cookies-from-browser selector, username, password (masked, server-side only) |
| **Advanced** | raw `YoutubeDL` options JSON escape hatch |

Format presets ship with: **Best Quality** (`bestvideo+bestaudio/best`), **1080p mp4**, **720p mp4**, **Audio only m4a**, **Audio only opus**.

## Subscription Flow

1. User pastes playlist URL into the "Add subscription" dialog and chooses whether to tick **"Download videos already in the playlist"** (default off) → `POST /api/subscriptions { url, check_interval_minutes, download_existing: bool, ... }`
2. Backend calls `ydl.extract_info(url, download=False, extract_flat='in_playlist')` to resolve the playlist title and initial video list
3. **First-poll behavior:**
   - If `download_existing == false`: insert every current video ID into `seen_videos` immediately, enqueue **nothing**. Only future uploads trigger downloads.
   - If `download_existing == true`: insert every current video ID into `seen_videos` AND enqueue a `Download` row for each. Treat them as "newly detected" for notification purposes.
4. APScheduler job registered for the subscription, running every `check_interval_minutes`
5. On each tick: worker re-extracts flat playlist, computes set diff against `seen_videos`, inserts new rows, creates `Download` rows for each, emits `subscription:new_video` and `notification:created` events, and enqueues each download through the download manager

## Design System Tokens (draft)

```css
:root {
  /* Color — dark-first premium palette */
  --color-bg:            #0A0A0B;
  --color-surface:       #141416;
  --color-surface-hi:    #1C1C1F;
  --color-border:        #26262A;
  --color-text:          #F5F5F7;
  --color-text-muted:    #A0A0A8;
  --color-accent:        #7C5CFF;
  --color-success:       #3FD97F;
  --color-warn:          #FFB84C;
  --color-error:         #FF5C5C;

  /* Spacing — 4px grid */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

  /* Radii */
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px;

  /* Typography */
  --font-sans: 'Plus Jakarta Sans', -apple-system, sans-serif;
  --text-xs: 12px; --text-sm: 14px; --text-base: 16px; --text-lg: 18px;
  --text-xl: 22px; --text-2xl: 28px; --text-3xl: 36px;

  /* Motion */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 120ms; --dur-base: 200ms; --dur-slow: 320ms;
}
```

All animations use `--ease-out` with `--dur-*` tokens — no ad-hoc timing values.

## Phased Implementation

The user explicitly asked to **start with the backend download manager**. Plan:

**Phase 1 — Scaffold + backend download manager (this session's work)**
1. `backend/` skeleton: `pyproject.toml`, FastAPI app factory, config, DB init
2. Models: `Download` (others stubbed)
3. `ytdl/service.py`: `extract_metadata(url)` and `download(url, opts, progress_cb)`
4. `services/download_manager.py`: ProcessPoolExecutor queue, cancellation, progress → WS broadcast
5. `routes/metadata.py` (`POST /api/metadata/resolve`) + `routes/downloads.py` (`POST/GET/DELETE /api/downloads`)
6. `ws.py`: socketio mount + `download:*` event emission
7. `frontend/` minimal scaffold: Vite + React + TS, one page ("Dashboard") that can paste a URL, call `/api/metadata/resolve`, start a download, and render live `download:updated` progress via socket.io-client
8. Smoke test end-to-end with a short public YouTube URL

**Phase 2 — Subscriptions + scheduler**
9. `Subscription`, `SeenVideo`, `Notification` models + migrations
10. `subscription_worker.py` + APScheduler wiring in app startup
11. `routes/subscriptions.py` CRUD + manual check trigger
12. `Subscriptions` page in frontend with list/add/configure/manual-check
13. `subscription:*` and `notification:*` events end-to-end

**Phase 3 — Full settings UI**
14. `FormatPicker` component with preset dropdown + advanced JSON editor
15. `Settings` page with all 8 tabs from the Configuration Surface table
16. Persisted via `/api/settings`, applied as defaults for future downloads

**Phase 4 — Design polish**
17. Skeleton loaders, framer-motion-free micro-interactions, toast notification center
18. Empty states, error states, loading states for every page
19. Responsive breakpoints (desktop-first; tablet/mobile as secondary)
20. Final pass on spacing, typography rhythm, and color contrast

## Critical Files To Be Created (Phase 1)

- `backend/pyproject.toml`
- `backend/app/main.py`
- `backend/app/config.py`
- `backend/app/db.py`
- `backend/app/models.py`
- `backend/app/schemas.py`
- `backend/app/events.py`
- `backend/app/ws.py`
- `backend/app/ytdl/service.py`
- `backend/app/ytdl/progress.py`
- `backend/app/services/download_manager.py`
- `backend/app/routes/metadata.py`
- `backend/app/routes/downloads.py`
- `frontend/package.json`
- `frontend/vite.config.ts`
- `frontend/index.html`
- `frontend/src/main.tsx`, `App.tsx`, `router.tsx`
- `frontend/src/ws/socket.ts`, `ws/events.ts`
- `frontend/src/api/client.ts`, `api/downloads.ts`, `api/metadata.ts`
- `frontend/src/pages/Dashboard/*`
- `frontend/src/components/DownloadRow/*`, `ProgressBar/*`
- `frontend/src/styles/tokens.css`, `global.css`, `reset.css`

## Verification Plan

**Backend unit tests** (`backend/tests/`):
- `test_download_manager.py`: mock `YoutubeDL`, assert queue transitions and WS event emission order
- `test_subscription_worker.py`: mock `extract_info`, assert `seen_videos` diffing and notification emission
- `test_routes.py`: FastAPI `TestClient` round-trips for `/api/downloads`, `/api/metadata/resolve`

**Prerequisites on the dev box:**
- Python 3.11+ available (the project's venv goes in `backend/.venv`)
- Node 20+ and npm
- `yt-dlp` and `ffmpeg` installed and on PATH (verify with `yt-dlp --version` and `ffmpeg -version`)

**End-to-end smoke test** (manual, Phase 1):
1. `cd backend && python -m venv .venv && .venv/Scripts/activate && pip install -e . && uvicorn app.main:app --reload`
2. `cd frontend && npm install && npm run dev`
3. Open `http://localhost:5173`, paste a short public YouTube URL (e.g. a 1-minute Creative Commons clip)
4. Verify: metadata resolves, format list populates, download starts, progress bar animates via WS, file lands in `./downloads/`
5. Check `download:added → download:updated (multiple) → download:completed` event sequence in browser devtools

**End-to-end subscription test** (manual, Phase 2):
1. `POST /api/subscriptions` with a small playlist URL, interval 1 min
2. Wait for first APScheduler tick; verify `subscription:checked` event with `new_count > 0`
3. Verify each new video emits `subscription:new_video`, creates a notification, and enqueues a download
4. Re-trigger manually; verify second check reports `new_count == 0`

## Locked Decisions

Confirmed with the user before finalizing:

1. **Deployment target → Local Windows dev only.** No Docker, no compose. Backend runs via `uvicorn` in a Python venv; frontend runs via `npm run dev` (Vite). yt-dlp and FFmpeg are assumed to be installed and on PATH — the README will document this. Skipping Docker keeps the iteration loop tight; we can revisit containerization later if it ships externally.
2. **First-poll behavior → User chooses per subscription.** The "Add subscription" dialog includes a checkbox: **"Download videos already in the playlist"** (default *off*, i.e. only future uploads). When unchecked, the worker backfills all current video IDs into `seen_videos` at subscribe time. When checked, every current video is enqueued immediately.
3. **Auth → Single-user, no auth.** Same model as MeTube. Assumes private network / reverse proxy. No user table, no sessions, no login UI. If exposure ever changes, a single-password gate can be added later as middleware without touching the data model.
