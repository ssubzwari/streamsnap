# MetubePlus

A self-hosted video downloader web app powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). Download videos and audio from YouTube and 1000+ other sites, subscribe to playlists with automatic polling, and watch real-time download progress in the browser.

[![Build & Push Docker Image](https://github.com/ssubzwari/metubeplus/actions/workflows/docker.yml/badge.svg)](https://github.com/ssubzwari/metubeplus/actions/workflows/docker.yml)

---

## Features

### Downloads
- **Video & audio downloads** — single videos, channels, or playlists
- **Format picker** — Type / Codec / Format / Quality dropdowns with smart fallback format specs
- **Playlist downloads** — paste a playlist URL and all videos are enqueued into a named subfolder; a review list lets you drop individual videos before anything starts
- **Real-time progress** — live speed, ETA, and progress bars via WebSocket (Socket.IO)
- **Queue control** — configurable concurrency (default 1, applied live), **Pause all** to halt active + queued downloads, **Resume stalled / Resume incomplete** to re-queue downloads left mid-flight after a restart, and automatic pause + alert when YouTube returns a bot-check error
- **Bulk actions** — checkboxes on every row; clear selected, clear completed, clear failed, retry failed. Selection-aware: check some rows to act on just those, or leave everything unchecked to act on the whole set. Retry re-queues in place (keeps the row and its original format/folder) — also available per-row on failed/canceled downloads.
- **Completed grouped by source** — finished downloads are organised into collapsible groups per subscription, plus an "Other" group for manual downloads; newest/oldest sort toggle
- **Play in browser** — click the ▶ icon to stream the finished file inline in a new tab (HTTP Range → native `<video>` with seek)
- **Download to device** — the ⬇ icon saves the finished file through the browser (works even when the server is on another machine); a server-side "reveal in file manager" endpoint is also available (Explorer / Finder / xdg-open)
- **Import / Export / Copy URLs** — bulk-add a list of URLs, export the queue, or copy all URLs to the clipboard
- **Episode-number padding** — single-digit episode numbers are zero-padded on download (`E1` → `E01`) for correct sorting in Plex/Jellyfin; a Settings action re-pads files already on disk

### Subscriptions
- **Channel/playlist subscriptions** — new videos are downloaded automatically on a configurable interval
- **Per-playlist folders** — each subscription and playlist download gets its own named subfolder
- **Backfill control** — choose whether to download existing videos or only future ones on subscribe; when backfilling, a review list lets you remove individual videos before any download starts (removed ones are still marked seen, so they won't come back as "new")
- **Per-subscription mute** — bell-icon toggle on each row (and at create time) silences alerts for that subscription while downloads still run
- **Check interval in days** — the interval is entered and shown in days (stored internally as minutes); a manual "Check now" button forces an immediate poll
- **Plex / Jellyfin artwork** — optionally fetch `poster.jpg` + `background.jpg` for each show folder from the first video's thumbnail (toggle in Settings → Metadata, or the 🖼 icon to (re)generate for an existing subscription)
- **Duplicate protection** — subscribing to a URL you're already subscribed to is rejected up front (no ghost rows); deleting a subscription cascades to its seen-videos and downloads so you can always cleanly re-subscribe

### Notifications
- **In-app toasts** — slide-in notifications for completed, failed, and new-video events
- **Browser notifications** — native OS-level alerts via the Web Notifications API
- **External channels** — push alerts to any combination of:
  - **SMTP** — email via any mail server (auto-detects implicit SSL on port 465 vs STARTTLS on 587; plain mode available for LAN)
  - **Slack** — incoming webhook
  - **Discord** — webhook
  - **Telegram** — Bot API
  - **Pushover** — mobile push notifications
- **Event suppression** — independently mute: Download completed / Download failed / New video from subscription / Subscription check error
- **Periodic summary** — configurable digest interval (hours) sent to all enabled channels; trigger manually with "Send summary now"

### Appearance
- **Dark & light themes** — toggle in Settings → Theme; every colour comes from CSS custom properties in `tokens.css`
- **Animated backgrounds** — "None" plus 15 page backgrounds: 5 WebGL effects (Net, Waves, Cells, Dots, Rings — Vanta/three.js) and 10 lightweight canvas effects (Aurora, Starfield, Grid Pulse, Bubbles, Matrix Rain, Plasma, Mesh Gradient, Constellation, Neon Lines, Snow). Choice persists to `localStorage`.
- **Built to stay smooth** — three.js is loaded on demand only when a WebGL background is selected; canvas effects share one 30 fps render loop that stops completely when the tab is hidden or a modal covers the page; the backing canvas is resolution-capped on HiDPI displays; `prefers-reduced-motion` paints a single static frame and collapses UI transitions

### Responsive
- **Phone layout** — below 640px the data tables reflow into stacked cards (each field labelled inline), section headers collapse from a full-width tap target, and queued downloads shrink to a single compact row while the active download keeps its full detail card

### Customisable dashboard
- **Download activity meter** — a collapsible panel above the download list with a 60-second throughput graph and a legend of live stats (current / peak / average speed, downloading, queued, completed bytes). Toggle it on/off in Settings → Theme → Interface.
- **Rearrangeable sections** — the ▲▼ buttons in each section header move the Advanced Options / Downloading / Completed / Subscriptions blocks up and down; the order persists per browser. "Reset section order" in Settings → Theme restores the default.

### Settings (10-tab UI)
- **Theme** — light/dark mode, animated background picker (see Appearance above), and Interface prefs (download activity meter, reset dashboard section order)
- **Format** — format spec, quality cap, codec preferences, merge container, format sort
- **Subtitles** — write/embed subs, language selection, auto-subs, format conversion
- **Metadata & Thumbnails** — embed thumbnail, write info JSON, embed chapters and metadata, per-show Plex/Jellyfin artwork (`poster.jpg` + `background.jpg`)
- **Post-processing** — SponsorBlock category removal, ffmpeg path, keep-video toggle
- **Download** — concurrent downloads (default 1, applied live), concurrent fragments, retries, rate limit, socket timeout, partial resume
- **Output** — download paths, output template with variable reference, restrict filenames
- **Auth** — cookies-from-browser, username/password (server-side only)
- **Advanced** — raw `YoutubeDL` options JSON escape hatch
- **yt-dlp updater** — one-click upgrade of the bundled yt-dlp to the latest release (works locally and inside Docker via a dedicated `/ytdlp` volume so the update survives container restarts)
- **Database admin** — schema version display (current / target), one-click **Backup** (hot SQLite `.backup()` — safe while downloads are running), **Download backup** to save a `.db` file locally, **Upload & Restore** to load a backup from your machine, **Restore** from any server-side backup, and **Initialize DB** to wipe downloads / subscriptions / seen videos / notifications while preserving your notification channels and app settings. Backups are written to `/ytdlp/db-backups` in Docker (persistent) or `./backups` locally.
- **Schema versioning** — at every startup the app checks the stored schema version against the target version and automatically applies any pending migrations before accepting requests

### Deployment
- **Docker** — single-container image with bundled frontend; multi-arch (`amd64` + `arm64`)
- **GitHub Actions** — automated build & push to GitHub Container Registry on every commit
- **Self-hosted dev** — backend on uvicorn + frontend on Vite dev server

---

## Quick Start — Docker (recommended)

```bash
# Pull and run the latest image
docker compose up -d
```

The `docker-compose.yml` pulls from GitHub Container Registry automatically. Three independent mounts keep data isolated:

- `${DOWNLOAD_DIR:-./downloads}` → `/downloads` — bind-mount for finished files
- `metubeplus-data` (named volume) → `/data` — SQLite database and app state
- `metubeplus-ytdlp` (named volume) → `/ytdlp` — yt-dlp install, so in-app updates persist across container restarts

```bash
# Pin a specific build
IMAGE_TAG=sha-04bdf92 docker compose up -d

# Custom download folder
DOWNLOAD_DIR=/media/nas/downloads docker compose up -d
```

Image: `ghcr.io/ssubzwari/metubeplus:latest`

---

## Quick Start — Local Dev

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | 3.11+ | [python.org](https://www.python.org/downloads/) |
| Node.js | 20+ | [nodejs.org](https://nodejs.org/) |
| yt-dlp | latest | `pip install yt-dlp` |
| ffmpeg | any | [ffmpeg.org](https://ffmpeg.org/download.html) or `winget install Gyan.FFmpeg` |

> **Note:** ffmpeg is required for 1080p+ quality (merging separate video+audio streams).

### Backend

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -e .
uvicorn app.main:socket_app --reload --port 8088
# → http://localhost:8088
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

Open **http://localhost:5173** in your browser.

---

## Project Structure

```
MetubePlus/
├── .github/
│   └── workflows/
│       └── docker.yml           # Build & push to ghcr.io on push to main
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI + Socket.IO app factory, SPA fallback
│   │   ├── config.py            # Settings (DB path, download dir, concurrency)
│   │   ├── db.py                # Async SQLAlchemy engine + session
│   │   ├── models.py            # ORM models (Download, Subscription, NotificationChannel…)
│   │   ├── schemas.py           # Pydantic DTOs
│   │   ├── events.py            # WebSocket event constants
│   │   ├── ws.py                # Socket.IO server + emit helpers
│   │   ├── routes/
│   │   │   ├── downloads.py     # Download CRUD + playlist + open-file + inline stream
│   │   │   ├── subscriptions.py # Subscription CRUD + manual check
│   │   │   ├── metadata.py      # URL metadata resolution
│   │   │   ├── notifications.py # Notifications + channel CRUD + test + summary
│   │   │   └── settings.py      # Key/value app settings (40+ yt-dlp options)
│   │   ├── services/
│   │   │   ├── download_manager.py    # ProcessPoolExecutor queue + progress relay
│   │   │   ├── subscription_worker.py # APScheduler polling jobs
│   │   │   ├── notifications.py       # Notification creation + WS emit
│   │   │   └── external_notifier.py   # SMTP / Slack / Discord / Telegram / Pushover
│   │   └── ytdl/
│   │       ├── service.py       # yt-dlp wrapper (metadata + download + settings apply)
│   │       └── progress.py      # progress_hook → queue adapter (throttled)
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard/       # Main UI — downloads, subscriptions, format picker
│   │   │   └── Settings/        # 10-tab settings modal (Theme, Format → Notifications)
│   │   ├── components/
│   │   │   ├── Toast/           # In-app toasts + browser Notification API
│   │   │   └── Skeleton/        # Shimmer loading placeholders
│   │   ├── theme/               # ThemeContext, Background.tsx, customEffects.ts (16 backgrounds)
│   │   ├── api/                 # fetch wrappers (downloads, subscriptions, notifications…)
│   │   ├── ws/                  # Socket.IO singleton + TypeScript event types
│   │   └── styles/              # tokens.css, global.css, reset.css
│   └── vite.config.ts           # Dev proxy → /api + /socket.io → :8088
├── Dockerfile                   # Multi-stage: node build → python:3.12-slim + ffmpeg
└── docker-compose.yml           # Pulls ghcr.io image; bind-mounts downloads + data volume
```

---

## Architecture

```
React Frontend (Vite + TypeScript + CSS Modules)
    ↓ REST (fetch)   ↓ Socket.IO
FastAPI Application (port 8088)
├── Download Manager    (ProcessPoolExecutor — yt-dlp off asyncio loop)
├── Subscription Worker (APScheduler AsyncIOScheduler)
├── External Notifier   (SMTP / Slack / Discord / Telegram / Pushover)
└── Routes: /api/downloads  /api/subscriptions  /api/metadata
              /api/settings  /api/notifications  /api/notifications/channels
      ↓
SQLite via SQLAlchemy 2.x (async + aiosqlite)
      ↓
yt-dlp  (YoutubeDL class, not subprocess)
```

---

## WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `download:added` | server→client | Download enqueued |
| `download:updated` | server→client | Progress tick (~2/sec) |
| `download:completed` | server→client | Download finished |
| `download:failed` | server→client | Worker exception |
| `download:canceled` | server→client | User canceled |
| `downloads:paused` | server→client | Queue paused/resumed (manual "Pause all" or bot-check auto-pause) |
| `subscription:checked` | server→client | APScheduler poll complete |
| `subscription:new_video` | server→client | New video detected in playlist |
| `notification:created` | server→client | Any notification (drives toasts + browser alert) |

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_URL` | `sqlite+aiosqlite:///./metubeplus.db` | Database path |
| `DOWNLOAD_DIR` | `./downloads` | Root download folder |
| `MAX_CONCURRENT_DOWNLOADS` | `1` | Legacy — set "Concurrent Downloads" in Settings → Download instead |
| `IMAGE_TAG` | `latest` | Docker image tag (compose only) |
| `PORT` | `8088` | Host port to expose (compose only) |

### Notification channels

Configure external notification channels in **Settings → Notifications**. Each channel requires:

| Kind | Required config |
|------|----------------|
| SMTP | host, port, username, password, from address, to address |
| Slack | Incoming Webhook URL |
| Discord | Webhook URL |
| Telegram | Bot token + Chat ID |
| Pushover | App token + User key |

Channels can be individually enabled/disabled and tested with a sample message.

---

## Design System

All visual tokens are in `frontend/src/styles/tokens.css`. No Tailwind, no CSS-in-JS — pure CSS Modules only. Colours and elevation are defined per theme (`:root` / `:root[data-theme='light']`); everything else is theme-agnostic.

| Token | Dark value | Light value |
|-------|-----------|-------------|
| `--color-bg` | `#0A0A0B` | `#F5F5F9` |
| `--color-surface` | `#141416` | `#FFFFFF` |
| `--color-accent` | `#7C5CFF` | `#5A3FFF` |
| `--color-success` | `#3FD97F` | `#1E9D54` |
| `--color-warn` | `#FFB84C` | `#C47A00` |
| `--color-error` | `#FF5C5C` | `#D6362F` |
| `--shadow-card` / `--shadow-pop` / `--edge-hi` | panel & modal elevation | (theme-aware) |
| Font | Plus Jakarta Sans (self-hosted) | |
| Spacing | 4px grid (`--space-1`…`--space-8`) | |
| Radii | `--radius-sm` 6px · `--radius-md` 10px · `--radius-lg` 16px | |
| Motion | easing `cubic-bezier(0.16, 1, 0.3, 1)`; `--dur-fast` 120ms · `--dur-base` 200ms · `--dur-slow` 320ms | |

`prefers-reduced-motion: reduce` collapses all transitions/animations app-wide and freezes the animated background.

---

## License

MIT
