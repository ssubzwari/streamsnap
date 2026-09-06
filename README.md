# StreamSnap

A self-hosted video downloader web app powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).
Download video and audio from YouTube and 1000+ other sites, subscribe to channels and
playlists with automatic polling, and watch real-time download progress in the browser.

[![Build & Push Docker Image](https://github.com/ssubzwari/streamsnap/actions/workflows/docker.yml/badge.svg)](https://github.com/ssubzwari/streamsnap/actions/workflows/docker.yml)

> **Security model:** single-user, **no authentication** — the same assumption as MeTube.
> Run it on a trusted private network or behind an authenticating reverse proxy. Several
> endpoints (the raw `YoutubeDL` options escape hatch, "reveal in file manager", the
> yt-dlp updater) can reach the host filesystem or run a process; never expose the
> instance directly to the internet.

---

## Features

### Downloads
- **Video & audio** — single videos, whole channels, or playlists
- **Format picker** — Type / Codec / Format / Quality dropdowns compose a format spec with
  fallback chains, plus one-click presets (Best, 1080p mp4, 720p mp4, Audio m4a, Audio opus)
- **Playlist review** — a playlist URL is expanded asynchronously (no reverse-proxy timeout
  on large channels); a review list lets you drop individual videos before anything is
  enqueued; all videos land in one named subfolder
- **Real-time progress** — live speed, ETA and progress bars over Socket.IO (~2 updates/sec)
- **Queue control** — live-applied concurrency (default 1), drag-to-reorder / "move to top" /
  nudge, **Pause all**, **Resume incomplete** (re-queues downloads a restart left mid-flight —
  yt-dlp resumes from the partial file), and an automatic pause + alert when YouTube returns
  a bot-check error
- **Bulk actions** — per-row checkboxes; clear selected / completed / failed, retry failed.
  Selection-aware. Retry re-queues **in place**, keeping the row's original format and folder.
- **Completed, grouped by source** — finished downloads collapse into per-subscription groups
  plus an "Other" group for manual downloads, with a newest/oldest toggle
- **Play in browser** — stream the finished file inline (HTTP Range → native `<video>` with seek)
- **Download to device** — save the file through the browser even when the server is remote;
  a server-side "reveal in file manager" endpoint (Explorer / Finder / `xdg-open`) is also available
- **Import / Export / Copy URLs** — bulk-add a URL list, export the queue, copy all URLs

### Organisation (Plex / Jellyfin friendly)
- **Category / Subcategory / Tag** on any download or subscription — these become folder
  levels under the download root (`Category/Subcategory/Tag/file.ext`), with autocomplete
  from what you've used before
- **Episode-number padding** — `E1` → `E01` on download so episodes sort correctly in
  Plex/Jellyfin; a Settings action re-pads files already on disk
- **Per-show artwork** — optionally fetch `poster.jpg` + `background.jpg` for each show
  folder from the first video's thumbnail

### Subscriptions
- **Channel / playlist subscriptions** — new videos download automatically on a configurable
  interval (entered in **days**; a manual **Check now** forces an immediate poll)
- **Backfill control** — on subscribe, choose to download existing videos or only future ones;
  when backfilling, a review list lets you remove individual videos (removed ones are still
  marked "seen" so they never return as "new")
- **Per-subscription mute** — silence alerts for one subscription while its downloads keep running
- **Duplicate protection** — re-subscribing to a known URL is rejected up front; deleting a
  subscription cascades to its seen-videos and downloads for a clean re-subscribe
- **Deduplication** — `UNIQUE(subscription_id, video_id)` plus yt-dlp's `--download-archive`
  as a secondary guard
- Each subscription downloads into its own named subfolder and passes its category tree
  down to every video it fetches
- **Plex / Jellyfin artwork** — the 🖼 button on a subscription (re)builds `poster.jpg` +
  `background.jpg` for its folder; enable it by default in Settings → Metadata & Thumbnails

### Notifications
- **In-app toasts** and **native browser notifications**
- **External channels** — any combination of:

  | Kind | Config |
  |---|---|
  | SMTP | host, port, username, password, from, to (auto-detects 465 implicit SSL / 587 STARTTLS / plain) |
  | Slack | Incoming Webhook URL |
  | Discord | Webhook URL |
  | Telegram | Bot token + Chat ID |
  | Pushover | App token + User key |

- **Independent gating** — a global per-event toggle controls the in-app toast/bell; each
  external channel has its **own** event filter, applied independently
- **Connection test** — every channel (saved or unsaved) returns a redacted, step-by-step
  debug transcript; bot tokens and webhook secrets are stripped from the output
- **Periodic summary** — a digest on a configurable hour interval to all enabled channels,
  or on demand with "Send summary now"
- Auth-required alerts always reach every enabled channel

### Appearance
- **Dark & light themes** — every colour comes from CSS custom properties in `tokens.css`
- **16 page backgrounds** — None, 5 WebGL effects (Net, Waves, Cells, Dots, Rings —
  Vanta / three.js) and 10 lightweight canvas effects (Aurora, Starfield, Grid Pulse,
  Bubbles, Matrix Rain, Plasma, Mesh Gradient, Constellation, Neon Lines, Snow)
- **Built to stay smooth** — three.js is loaded on demand only for a WebGL background;
  canvas effects share one 30 fps loop that stops entirely when the tab is hidden or a modal
  is open; the backing canvas is DPR-capped on HiDPI displays; `prefers-reduced-motion`
  paints one static frame and collapses all UI transitions
- Choice persists to `localStorage`

### Dashboard
- **Download activity meter** — a collapsible panel with a 60-second throughput graph
  (auto-scaled to the recent peak) and a one-line stat legend; drag the bottom edge to
  resize (height persists); shows a mini sparkline when collapsed. Toggle in Settings → Theme.
- **Rearrangeable sections** — move the Advanced / Downloading / Completed / Subscriptions
  blocks up and down; order persists per browser ("Reset section order" in Settings)
- **Phone layout** — below 640px the tables reflow into stacked, inline-labelled cards;
  section headers collapse; queued rows shrink to a single line while the active download
  keeps its full card

### Settings (tabbed UI)
**Theme · General · Format · Subtitles · Metadata & Thumbnails · Post-processing ·
Download · Output · Auth · Advanced · Notifications**

- **Format** — format spec + presets, quality cap (height), preferred codec (vp9/av1/h264),
  audio codec (opus/aac/m4a), merge container (mp4/mkv/webm), `--prefer-free-formats`, `--format-sort`
- **Subtitles** — write subs, languages, auto-subs, embed, convert format
- **Metadata & Thumbnails** — embed/write thumbnail, write info JSON, write description,
  embed metadata, embed chapters, per-show Plex/Jellyfin artwork (`poster.jpg` + `background.jpg`)
- **Post-processing** — SponsorBlock category removal, ffmpeg location, keep-video, episode-number padding
- **Download** — concurrent downloads (live-applied), concurrent fragments, retries,
  fragment retries, rate limit, socket timeout, continue partial, no-overwrites
- **Output** — temp/home paths, output template with a variable reference, restrict filenames,
  "Fix existing files" → zero-pad episode numbers already on disk
- **Auth** — cookies-from-browser, username / password (stored server-side, never returned to the browser)
- **Advanced** — schema-version display, one-click yt-dlp updater, database admin, and a
  raw `YoutubeDL` options JSON escape hatch (applied last, overrides everything)

### yt-dlp lifecycle
yt-dlp is used as a **library** (the `YoutubeDL` class), not shelled out to. It lives in a
dedicated directory (`YTDLP_DIR`; a `/ytdlp` Docker volume) so the in-app **"Update to latest"**
survives container restarts without an image rebuild. Delete the volume to reset to the
image's bundled version.

### Database admin (Settings → Advanced)
- **Backup now** — hot SQLite `.backup()`, safe while downloads run
- **Download / Upload & Restore / Restore** — move a `.db` file to or from your machine,
  or restore any server-side backup (engine connections are disposed first — Windows file-lock safe)
- **Initialize DB** — wipe downloads / subscriptions / seen-videos / notifications while
  **preserving** notification channels and app settings
- **Schema versioning** — at every startup the app compares the stored schema version to the
  target and applies any pending migrations before accepting requests

### Deployment
- **Docker** — one container, bundled frontend, multi-arch (`amd64` + `arm64`)
- **GitHub Actions** — build & push to GitHub Container Registry on every push to `main`
- **Local dev** — uvicorn backend + Vite dev server

---

## Quick Start — Docker (recommended)

```bash
docker compose up -d
```

`docker-compose.yml` pulls `ghcr.io/ssubzwari/streamsnap:latest` and sets up three
independent mounts:

| Mount | Target | Purpose |
|---|---|---|
| `${DOWNLOAD_DIR:-./downloads}` (bind) | `/downloads` | Finished files, directly on the host |
| `streamsnap-data` (named volume) | `/data` | SQLite database + app state |
| `streamsnap-ytdlp` (named volume) | `/ytdlp` | yt-dlp install, so in-app updates persist |

```bash
IMAGE_TAG=sha-04bdf92 docker compose up -d              # pin a build
DOWNLOAD_DIR=/media/nas/downloads docker compose up -d   # custom folder
PORT=9000 docker compose up -d                           # custom host port
```

### Migrating from MetubePlus

The project was renamed; volumes, the DB filename and the image path changed from
`metubeplus*` to `streamsnap*`.

```bash
docker compose down
docker volume create streamsnap-data && docker volume create streamsnap-ytdlp
docker run --rm -v metubeplus-data:/from -v streamsnap-data:/to alpine sh -c 'cp -a /from/. /to/'
docker run --rm -v metubeplus-ytdlp:/from -v streamsnap-ytdlp:/to alpine sh -c 'cp -a /from/. /to/'
docker run --rm -v streamsnap-data:/data alpine mv /data/metubeplus.db /data/streamsnap.db
docker compose up -d
```

Browser preferences (theme, layout) migrate automatically. Old `metubeplus-*.db` backups
stay listed in Settings → Advanced.

---

## Quick Start — Local Dev

### Prerequisites (must be on `PATH`)

| Tool | Version |
|---|---|
| Python | 3.11+ |
| Node.js | 20+ |
| yt-dlp | latest (`pip install yt-dlp`) |
| ffmpeg | any (required for 1080p+ — merges separate video+audio streams) |

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # macOS / Linux
pip install -e .
uvicorn app.main:socket_app --reload --port 8088   # -> http://localhost:8088
```

> uvicorn must target **`socket_app`**, not `app` — python-socketio wraps the FastAPI ASGI app.

### Frontend

```bash
cd frontend
npm install
npm run dev     # -> http://localhost:5173  (proxies /api + /socket.io -> :8088)
```

### Tests

```bash
cd backend && pytest tests/
```

---

## Architecture

```
React (Vite + TypeScript + CSS Modules)
   |  REST (fetch)        |  Socket.IO
FastAPI  (served as socket_app on :8088)
|-- Download Manager       ThreadPoolExecutor — keeps blocking yt-dlp calls off the asyncio loop
|-- Subscription Worker     APScheduler AsyncIOScheduler — flat-playlist diff -> enqueue
|-- Notification Dispatcher in-app + SMTP / Slack / Discord / Telegram / Pushover
`-- Routes: /api/downloads  /api/subscriptions  /api/metadata
           /api/settings    /api/notifications  /api/notifications/channels
   |
SQLite  (async SQLAlchemy 2.x + aiosqlite, single file, startup migrations)
   |
yt-dlp  (YoutubeDL class; progress via progress_hooks)
```

**Key decisions**
- Downloads run in a `ThreadPoolExecutor` — yt-dlp downloads are I/O-bound (network + disk),
  so threads keep the blocking work off the event loop without the pickling / Windows-spawn
  complexity of multiprocessing. A per-download `threading.Event` handles cancellation.
- The worker queue is a bare **wake token** — each pass re-reads the lowest `queue_position`
  `queued` row from the DB, so a reorder takes effect on the next pick.
- Subscription dedup: a `seen_videos` table with `UNIQUE(subscription_id, video_id)`.
- Frontend state: colocated `useReducer` reducers in `Dashboard/index.tsx`; theme via
  `ThemeContext`; per-browser prefs via `UiPrefsContext`. No global store library.

---

## REST API Reference

### Metadata
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/metadata/resolve` | Resolve a URL -> title, thumbnail, duration, formats |

### Downloads
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/downloads` | Create a download |
| `GET` | `/api/downloads` | List all downloads |
| `GET` | `/api/downloads/status` | Queue status summary |
| `GET` | `/api/downloads/grouped` | Completed downloads grouped by subscription |
| `GET` | `/api/downloads/export` | Export the queue as a URL list |
| `GET` | `/api/downloads/categories` | Category -> subcategory -> tag tree (autocomplete) |
| `GET` | `/api/downloads/tags` | Tags in use, grouped by category |
| `POST` | `/api/downloads/pad-episodes` | Zero-pad episode numbers of files already on disk |
| `POST` | `/api/downloads/playlist/preview` | Start async playlist expansion -> `202` + job id |
| `GET` | `/api/downloads/playlist/preview/{job_id}` | Poll expansion job |
| `POST` | `/api/downloads/playlist` | Enqueue a reviewed playlist |
| `POST` | `/api/downloads/queue/reorder` | Rewrite queue positions (`{ordered_ids}`) |
| `POST` | `/api/downloads/pause-all` | Pause / resume the whole queue |
| `POST` | `/api/downloads/resume-incomplete` | Re-queue downloads left mid-flight |
| `GET` | `/api/downloads/{id}` | Get one download |
| `POST` | `/api/downloads/{id}/retry` | Retry in place (keeps format + folder) |
| `DELETE` | `/api/downloads/{id}` | Delete (cascades) |
| `GET` | `/api/downloads/{id}/file` | Download the finished file to the browser |
| `GET` | `/api/downloads/{id}/stream` | Inline stream with HTTP Range |
| `GET` | `/api/downloads/{id}/open` | Reveal in the host's file manager (`501` if headless) |

### Subscriptions
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/subscriptions` | Create (with `download_existing`, `download_video_ids`, category tree) |
| `GET` | `/api/subscriptions` | List |
| `GET` | `/api/subscriptions/{id}` | Get one |
| `PATCH` | `/api/subscriptions/{id}` | Update interval / format / template / active / notify / category |
| `DELETE` | `/api/subscriptions/{id}` | Delete (cascades to seen-videos + downloads) |
| `POST` | `/api/subscriptions/{id}/check` | Force an immediate poll (`202`) |
| `POST` | `/api/subscriptions/{id}/artwork` | (Re)generate `poster.jpg` + `background.jpg` (`202`) |

### Notifications
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notifications` | List notifications |
| `PATCH` | `/api/notifications/{id}/read` | Mark one read |
| `POST` | `/api/notifications/read-all` | Mark all read |
| `GET` | `/api/notifications/channels` | List channels |
| `POST` | `/api/notifications/channels` | Create a channel |
| `PATCH` | `/api/notifications/channels/{id}` | Update a channel |
| `DELETE` | `/api/notifications/channels/{id}` | Delete a channel |
| `POST` | `/api/notifications/channels/test` | Test an **unsaved** config |
| `POST` | `/api/notifications/channels/{id}/test` | Test a **saved** channel |
| `POST` | `/api/notifications/summary` | Send a summary digest now |

### Settings
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings` | Read all settings |
| `PUT` | `/api/settings` | Write settings (whitelisted keys only) |
| `GET` | `/api/settings/ytdlp-version` | Installed yt-dlp version |
| `POST` | `/api/settings/update-ytdlp` | Upgrade yt-dlp in the isolated dir |
| `GET` | `/api/settings/db/schema-version` | Current / target schema version |
| `GET` | `/api/settings/db/backups` | List backups |
| `POST` | `/api/settings/db/backup` | Create a hot backup |
| `POST` | `/api/settings/db/restore` | Restore a server-side backup |
| `GET` | `/api/settings/db/backups/{name}/download` | Download a backup file |
| `POST` | `/api/settings/db/backups/upload` | Upload a `.db` file |
| `DELETE` | `/api/settings/db/backups/{name}` | Delete a backup |
| `POST` | `/api/settings/db/initialize` | Wipe user data, keep channels + settings |

### Health
`GET /health` -> `{"status": "ok"}`

---

## WebSocket Events (server -> client)

| Event | Trigger |
|---|---|
| `download:added` | Download enqueued |
| `download:updated` | Progress tick (~2/sec, throttled) |
| `download:completed` | Download finished |
| `download:failed` | Worker exception |
| `download:canceled` | User cancels |
| `downloads:paused` | Queue paused/resumed (manual or bot-check auto-pause) |
| `subscription:checked` | APScheduler poll completed |
| `subscription:new_video` | New video detected (fires before auto-download enqueues) |
| `notification:created` | Any notification (drives toasts + browser alerts) |

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `APP_NAME` | `StreamSnap` | Display name |
| `DEBUG` | `false` | Verbose mode |
| `DB_URL` | `sqlite+aiosqlite:///./streamsnap.db` | Database URL |
| `DOWNLOAD_DIR` | `./downloads` | Root download folder |
| `YTDLP_DIR` | `""` (Docker: `/ytdlp`) | Isolated yt-dlp install dir |
| `CORS_ORIGINS` | `""` (any origin) | Comma-separated cross-origin allowlist for REST + WebSocket; restrict it when reachable from an untrusted network |
| `MAX_CONCURRENT_DOWNLOADS` | `1` | **Legacy** — set *Concurrent Downloads* in Settings -> Download |
| `IMAGE_TAG` | `latest` | Docker image tag (compose only) |
| `PORT` | `8088` | Host port (compose only) |

Values are loaded from the environment and an optional `.env` file. Runtime yt-dlp options
and all notification-channel credentials are stored in the database via the Settings UI,
**not** in environment variables.

---

## Data Model

| Table | Key columns |
|---|---|
| `downloads` | id, url, title, status, percent, speed, eta, queue_position, format_spec, output_dir, output_path, error_message, subscription_id FK, ext, filesize, height, vcodec, acodec, category/subcategory/tag |
| `subscriptions` | id, url, title, check_interval_minutes, last_checked_at, format_spec, output_template, is_active, download_existing, download_dir, notify, category/subcategory/tag |
| `seen_videos` | id, subscription_id FK, video_id, title, upload_date — `UNIQUE(subscription_id, video_id)` |
| `notification_channels` | id, kind, name, config_json, events_json (per-channel filter; NULL = default set), is_enabled |
| `notifications` | id, kind, title, body, thumbnail, payload_json, is_read, created_at |
| `settings` | key/value store for yt-dlp defaults + internal `schema_version` |

---

## Design System

All visual tokens live in `frontend/src/styles/tokens.css` — no Tailwind, no CSS-in-JS,
CSS Modules only. Colours and elevation are defined per theme (`:root` /
`:root[data-theme='light']`); everything else is theme-agnostic.

| Token | Dark | Light |
|---|---|---|
| `--color-bg` | `#0A0A0B` | `#F5F5F9` |
| `--color-surface` | `#141416` | `#FFFFFF` |
| `--color-accent` | `#7C5CFF` | `#5A3FFF` |
| `--color-success` | `#3FD97F` | `#1E9D54` |
| `--color-warn` | `#FFB84C` | `#C47A00` |
| `--color-error` | `#FF5C5C` | `#D6362F` |

Spacing on a 4px grid (`--space-1`...`--space-8`); radii sm 6 / md 10 / lg 16; font Plus
Jakarta Sans (self-hosted); motion always `cubic-bezier(0.16, 1, 0.3, 1)` with `--dur-fast`
120ms / `--dur-base` 200ms / `--dur-slow` 320ms. `prefers-reduced-motion: reduce` collapses
all animation app-wide.

---

## License

MIT
