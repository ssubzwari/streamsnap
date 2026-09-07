# StreamSnap — Deep Dive Guide

In-depth documentation for seven core subsystems: **Subscriptions**, **Notifications**,
the **Queue / concurrency model**, the **Database backup & restore system**, the
**Download activity meter**, the **yt-dlp updater**, and **background themes**.

Each section covers what the feature does and why it's built the way it is, a realistic
example, and the edge cases / best practices / security notes that matter in production.
A full endpoint list is in the [REST API Reference](#appendix-rest-api-reference) appendix.

---

## 1. Subscriptions

### What it does

A subscription is a saved channel or playlist URL that StreamSnap re-checks on a fixed
interval. On each check it extracts the current video list, diffs it against what it has
already seen, and enqueues a download for anything new. It is the "set it and forget it"
half of the app.

Source: `backend/app/services/subscription_worker.py`, `backend/app/routes/subscriptions.py`.

### Why it's built this way

- **APScheduler `AsyncIOScheduler`**, one interval job per active subscription keyed
  `sub_{id}`. Jobs live in memory and are rebuilt from the DB at startup
  (`start_scheduler()`), so there is no separate "scheduler state" to keep in sync.
- **`seen_videos` table with `UNIQUE(subscription_id, video_id)`** is the source of truth
  for "have I handled this video". Even if a download row is deleted, the video stays seen
  and never re-downloads. yt-dlp's own `--download-archive` is a secondary guard, not the
  primary one.
- **The playlist is extracted "flat"** (`extract_playlist()` — metadata only, no format
  probing) in a worker thread via `asyncio.to_thread`, because a large channel can take
  tens of seconds and must not block the event loop.
- **Backfill is a choice made once, at subscribe time.** `download_existing=false` (the
  default) records every current video as seen and downloads nothing — you only get future
  uploads. `download_existing=true` records them as seen *and* enqueues them.

### Example — create a subscription via the API

```bash
# Future uploads only (default). Poll every 6 hours.
curl -X POST http://localhost:8088/api/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://www.youtube.com/@SomeChannel",
        "check_interval_minutes": 360,
        "format_spec": "bestvideo[height<=1080]+bestaudio/best",
        "notify": true,
        "download_existing": false
      }'
```

```bash
# Backfill, but only three specific videos from the existing catalogue.
# Every current video is still marked seen; the other ones just won't download.
curl -X POST http://localhost:8088/api/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://www.youtube.com/playlist?list=PLxxxxxxxx",
        "check_interval_minutes": 1440,
        "download_existing": true,
        "download_video_ids": ["abc123", "def456", "ghi789"]
      }'
```

```bash
# Force an immediate poll without waiting for the next interval.
curl -X POST http://localhost:8088/api/subscriptions/7/check   # -> 202 Accepted
```

### What one poll actually does (`check_subscription`)

1. Load the subscription; bail if it is missing or `is_active = false`.
2. Extract the flat playlist in a thread. On failure → emit `subscription:checked` is
   skipped, a `subscription_error` notification is created (only if `notify` is on), return.
3. Load the set of already-seen `video_id`s.
4. Build the "new" list — skip anything already seen, and de-dupe within the extraction
   itself (some playlists surface the same video twice).
5. For each new entry: insert a `seen_videos` row; probe the subscription's folder for a
   file that already matches the title (`find_existing_file`) — if found, create the
   `Download` row as `completed` and skip the re-download; otherwise create it `queued` and
   call `download_manager.enqueue(...)`.
6. Emit `subscription:new_video` per video, then `download:added` (+ `download:completed`
   for the skip case).
7. Update `last_checked_at`, commit, emit `subscription:checked` with `new_count`.
8. If `new_count > 0` and `notify` is on, create **one** `new_video` notification
   summarising up to five titles.

### Edge cases & best practices

- **Interval units.** The UI collects and displays **days**; the DB column
  `check_interval_minutes` and the API field are **minutes**. Convert at the boundary.
- **Very short intervals hammer the site and get you rate-limited or bot-checked.** Treat
  anything under ~30 minutes as abuse of the source. Daily is plenty for most channels.
- **Deleting a subscription cascades** to its `seen_videos` *and* its `Download` rows
  (`routes/subscriptions.py`), specifically so you can cleanly re-subscribe to the same URL
  later. If you want to keep the downloaded files, they are already on disk — only the DB
  rows go.
- **Duplicate URLs are rejected at create time** — there is no "ghost row" left behind, so
  a failed create is safe to retry.
- **`notify=false` silences alerts but not downloads.** Use it for high-volume channels
  where you want the files but not six toasts an hour.
- **A manual "Check now" runs the exact same job function** as the scheduled tick — there
  is no separate code path, so anything that works on a poll works on a manual check.
- **Backfilling a 2000-video channel** enqueues 2000 downloads at once. They respect the
  concurrency limit (see §3), but the initial `seen_videos` insert and the review-list
  extraction can be heavy — the API accepts a pre-fetched `playlist_title` + `entries`
  payload from the client's review step so the server doesn't re-extract.

### Security notes

- The subscription URL is passed to yt-dlp. Only subscribe to sources you trust; yt-dlp
  extractors execute site-specific logic.
- `format_spec` and `output_template` are stored verbatim and handed to `YoutubeDL`. In the
  single-user model this is fine, but if you ever put StreamSnap behind shared access,
  treat these fields as untrusted (an output template can write outside the download dir).

---

## 2. Notifications

### What it does

A single `create_notification(kind, title, body, thumbnail, payload)` call drives every
alert surface: the in-app toast + bell, and any number of external channels (SMTP, Slack,
Discord, Telegram, Pushover).

Source: `backend/app/services/notifications.py`, `backend/app/services/external_notifier.py`,
`backend/app/routes/notifications.py`.

### Why it's built this way — two independent decisions

`create_notification` makes **two decisions that do not affect each other**:

| Decision | Controlled by | Default |
|---|---|---|
| Create the in-app `Notification` row + emit `notification:created` (toast/bell) | Global `notify_on_*` Setting for that kind | see table below |
| Dispatch to external channels | Each channel's own `events_json` filter | `DEFAULT_CHANNEL_EVENTS` when `events_json` is NULL |

So you can have the in-app "download complete" toast **off** while a Telegram channel still
posts every completion — or the reverse. The external dispatch is fired as a detached
`asyncio.create_task`, so a slow SMTP server never delays the API response.

Notification kinds and their in-app gate:

| Kind | Gate Setting | Default |
|---|---|---|
| `download_started` | `notify_on_download_start` | `false` |
| `completed` | `notify_on_complete` | `true` |
| `failed` | `notify_on_failed` | `true` |
| `playlist_completed` | `notify_on_playlist_complete` | `true` |
| `new_video` | `notify_on_new_video` | `false` |
| `subscription_error` | `notify_on_subscription_error` | `true` |
| `auth_required` | *(no gate — always created)* | — |
| `summary` | *(not an in-app kind — external only)* | — |

`auth_required` (YouTube sign-in wall) is in `_ALWAYS_SEND` — it reaches **every** enabled
channel regardless of that channel's filter, because it is the one alert you cannot afford
to miss.

### Example — add a Slack channel that only carries failures and the daily summary

```bash
curl -X POST http://localhost:8088/api/notifications/channels \
  -H 'Content-Type: application/json' \
  -d '{
        "kind": "slack",
        "name": "streamsnap-alerts",
        "config_json": "{\"webhook_url\":\"https://hooks.slack.com/services/T000/B000/xxxx\"}",
        "events_json": "[\"failed\",\"subscription_error\",\"summary\"]",
        "is_enabled": true
      }'
```

Config shape per kind (the `config_json` string is a JSON object):

| Kind | Keys |
|---|---|
| `slack` | `webhook_url` |
| `discord` | `webhook_url` |
| `telegram` | `bot_token`, `chat_id` |
| `pushover` | `app_token`, `user_key` |
| `smtp` | `host`, `port`, `username`, `password`, `from_email`, `to_email`, and optionally `security` = `ssl` \| `starttls` \| `none` |

### Example — test a channel before saving

```bash
curl -X POST http://localhost:8088/api/notifications/channels/test \
  -H 'Content-Type: application/json' \
  -d '{"kind":"smtp","config_json":"{\"host\":\"smtp.gmail.com\",\"port\":587,\"username\":\"me@gmail.com\",\"password\":\"app-password\",\"to_email\":\"me@gmail.com\"}"}'
```

Response is a **redacted, step-by-step transcript** — never raises:

```json
{
  "ok": true,
  "logs": [
    "Channel: smtp",
    "Config provided: host, password, port, to_email, username",
    "Connecting to smtp.gmail.com:587 (mode=starttls)",
    "From me@gmail.com -> me@gmail.com",
    "STARTTLS negotiated",
    "Authenticating as me@gmail.com",
    "Message accepted by server",
    "OK — delivered in 812 ms"
  ],
  "error": null
}
```

### SMTP mode detection

`_send_smtp_sync` picks the transport in this order:

1. Explicit `security` (or legacy `mode`) = `ssl` / `starttls` / `none`.
2. Legacy boolean `use_tls`: `true` → `starttls`, `false` → `none`.
3. Auto: port `465` → implicit SSL (`SMTP_SSL`); anything else → `STARTTLS`.

`none` (plain, unencrypted) exists for a LAN relay only.

### Edge cases & best practices

- **Secret redaction is regex-based** (`_SECRET_RE`): Telegram `bot<digits>:<token>`, Slack
  `hooks.slack.com/services/...`, Discord `discord.com/api/webhooks/<id>/<token>`. These
  are stripped from every transcript line and every echoed HTTP error body. A secret in an
  *unexpected* format (a webhook on a custom domain, an API key in a query param other than
  the known ones) will **not** be caught — review a transcript before pasting it into a
  public issue.
- **Gmail / Microsoft need an app password**, not your account password, and often require
  the "from" address to match the authenticated user.
- **A failed channel does not fail the notification.** `dispatch()` catches and logs per
  channel; other channels and the in-app row are unaffected.
- **`events_json = null` ≠ `events_json = []`.** NULL means "use the default set"
  (`completed`, `failed`, `playlist_completed`, `subscription_error`, `summary`); `[]` means
  "this channel receives nothing except `auth_required`".
- **Subscription downloads deliberately don't emit per-video `completed` notifications** —
  they roll up into a single `playlist_completed` summary once the whole batch drains
  (`download_manager._notify_completion`). One-off downloads still notify individually.
- **The periodic summary only sends if there are unread notifications** (`send_summary()`
  pulls up to 50 unread). An all-quiet interval sends nothing.

### Security notes

- **All channel credentials live in `notification_channels.config_json` in the SQLite DB**,
  in plaintext. A DB backup contains every SMTP password, bot token, and webhook URL —
  treat backup files as secrets (see §4).
- Webhook URLs are themselves bearer credentials. Anyone with the Slack/Discord webhook URL
  can post to that channel.
- The test endpoints (`/channels/test`, `/channels/{id}/test`) will make an outbound
  request to any host in the config. In the single-user model this is expected; behind
  shared access it is an SSRF vector.

---

## 3. Queue / concurrency model

### What it does

Turns an unbounded list of `queued` download rows into a controlled number of concurrent
yt-dlp runs, in a user-defined order, that survive reorders, pauses, cancellations, and
process restarts.

Source: `backend/app/services/download_manager.py`.

### The core idea: the in-memory queue is a *doorbell*, not a *list*

`DownloadManager._job_queue` is an `asyncio.Queue` that only ever holds a meaningless
sentinel object (`_WAKE`). It answers one question: "has something changed — should I look
at the DB again?" The **actual** next download is always chosen by `_pick_next_job()`,
which runs this query every pass:

```sql
SELECT * FROM downloads
WHERE status = 'queued'
ORDER BY (queue_position IS NULL), queue_position ASC, created_at ASC;
```

Consequences:
- A reorder (`POST /api/downloads/queue/reorder`) just rewrites `queue_position` values.
  The very next pick sees the new order — no queue rebuild, no cancellation.
- The wake token is **guarded** (`_wake()` only enqueues if the queue is empty), so
  bursts of events don't pile up tokens. An earlier bug where each download consumed one
  token — and a pass that found nothing runnable "burned" a token permanently and stalled
  the rest of the queue — is structurally impossible now.

### Concurrency gating

Two separate limits:

| Limit | Value | Purpose |
|---|---|---|
| `_EXECUTOR_MAX_WORKERS` | 16 (fixed) | Thread-pool ceiling — just a sane upper bound |
| `_concurrency` | `max_concurrent_downloads` setting, clamped to **1–12**, default **1** | The real "how many at once" |

`set_concurrency(n)` is called live from `PUT /api/settings` when you change the Download
tab, and it takes effect immediately — raising the limit sets `_slot_free` to wake the
worker, lowering it lets in-flight downloads finish and simply doesn't start new ones.

The worker loop (`_process_queue`):

```
block on _job_queue.get()          # the doorbell
loop:
    await _resume_event            # blocks here while paused
    while _running >= _concurrency:
        await _slot_free           # blocks here while all slots busy
    if _paused: break
    picked = _pick_next_job()      # lowest queue_position 'queued' row
    if picked is None: break       # queue drained
    _start_job(...)                # submit to ThreadPoolExecutor
```

Why threads, not processes: `download_manager.py`'s docstring says it plainly — yt-dlp
downloads are I/O-bound (network + disk), so the GIL is not the bottleneck, and threads
avoid multiprocessing's pickling and Windows-spawn headaches. Cancellation is a
`threading.Event` per download, checked inside the progress hook.

### Pause / resume

`pause(reason)`:
1. Set `_paused`, clear `_resume_event`.
2. Drain every pending wake token.
3. For each in-flight download: add its id to `_paused_ids`, set its cancel event, cancel
   its `Future`.
4. Emit `downloads:paused {paused: true, reason}`.

The cancelled downloads raise inside their worker thread; the relay sees the error, notices
the id is in `_paused_ids`, and puts the row back to **`queued`** (not `failed`/`canceled`).
`resume()` clears the flag and rings the doorbell — `_pick_next_job` picks those rows up
again and yt-dlp continues from the `.part` file.

### The YouTube bot-check auto-pause

If a download error matches `_BOT_CHECK_MARKERS` ("sign in to confirm you're not a bot",
`--cookies-from-browser`, …):
- The row goes back to `queued` with its error cleared (it was never a real failure).
- `pause("YouTube is asking StreamSnap to confirm it's not a bot…")` stops the whole queue.
- One `auth_required` notification fires (to every channel).

You fix it in **Settings → Auth** (cookies-from-browser), then click **Resume**.

### Restart recovery — `resume_incomplete()`

Runs automatically in the FastAPI lifespan, and is also the `POST /api/downloads/resume-incomplete`
endpoint. It:
- Lifts any pause.
- Finds rows that are `queued`, `downloading`, or `failed` with a "not a bot" error.
- Skips anything currently running (a manual re-run mid-flight won't double-enqueue).
- Marks rows whose file is already on disk as `completed`.
- Resets the rest to `queued` and re-enqueues them.

### Example — reorder the queue

```bash
# Put download 42 first, then 17, then 8. Any queued rows not listed keep their
# relative order after these.
curl -X POST http://localhost:8088/api/downloads/queue/reorder \
  -H 'Content-Type: application/json' \
  -d '{"ordered_ids": [42, 17, 8]}'
```

```bash
curl -X POST http://localhost:8088/api/downloads/pause-all       # toggles pause/resume
curl -X POST http://localhost:8088/api/downloads/resume-incomplete
```

### Edge cases & best practices

- **Concurrency > 1 multiplies bot-check risk on YouTube.** Parallel requests from one IP
  without cookies is exactly the pattern that triggers the sign-in wall. If you run 3–4
  concurrent, set up cookies-from-browser first.
- **`queue_position` is `NULL` for legacy rows** (created before migration v3) and for rows
  not yet enqueued; NULL sorts *last*. `enqueue()` assigns `max(queue_position) + 1` to any
  row without one, so resumed downloads keep their slot and a restart doesn't shuffle.
- **Deleting a `downloading` row** is detected in the relay (`_get_download` returns None) —
  the worker's cancel event is set and it cleans up. No orphaned threads.
- **`start()` is idempotent** and rebuilds every asyncio primitive + the progress queue, so
  the FastAPI lifespan can cycle repeatedly (the test suite depends on this). Don't hold a
  reference to `_job_queue` / `_resume_event` across a restart.
- **The concurrency clamp is 1–12.** Values outside that range in the setting are silently
  clamped, not rejected.

### Security notes

- Nothing in the queue path is network-exposed beyond the documented endpoints, and none
  take arbitrary paths. The risk surface here is purely operational (rate-limiting / bans
  from the source site), not injection.

---

## 4. Database backup & restore system

### What it does

Point-in-time snapshots of the single SQLite database, taken safely while the app is
running, plus the ability to move those snapshots on and off the server and restore one
in place.

Source: `backend/app/routes/settings.py` (the `/api/settings/db/*` routes).

### Where backups live

```
_backup_dir():
    YTDLP_DIR set (Docker)  ->  <YTDLP_DIR>/db-backups   (e.g. /ytdlp/db-backups)
    YTDLP_DIR empty (local) ->  ./backups
```

In Docker the backups share the `streamsnap-ytdlp` named volume, so there is only **one**
persistent volume to think about for both yt-dlp updates and backups. `_clean_target()`
(the yt-dlp updater) explicitly skips the `db-backups` folder when it wipes that dir.

### Why `sqlite3.Connection.backup()` and not a file copy

A plain `cp streamsnap.db backup.db` while a download is writing can capture a torn page
and produce a corrupt backup. `backup_db()` opens **fresh** `sqlite3` connections (outside
the async engine's pool) and uses SQLite's online backup API, which produces a
transactionally consistent copy even under concurrent writes. It runs in a thread
(`asyncio.to_thread`) so it doesn't block the loop.

### Why restore disposes the engine first

On Windows you cannot replace a file that has an open handle. `restore_db()`:

1. `await engine.dispose()` — drops every pooled connection so SQLite releases the file.
2. Copies the backup to `<db>.tmp`, then `os.replace(tmp, db)` — atomic, so a crash
   mid-write never leaves a half-restored DB.
3. The engine re-opens the restored file lazily on the next query. Live WebSocket sessions
   keep working.

### Example — full backup / download / restore cycle

```bash
# 1. Take a hot backup
curl -X POST http://localhost:8088/api/settings/db/backup
# -> {"name":"streamsnap-20260906-141200.db","size":81920,"created_at":"..."}

# 2. List backups
curl http://localhost:8088/api/settings/db/backups

# 3. Pull it to your machine
curl -OJ http://localhost:8088/api/settings/db/backups/streamsnap-20260906-141200.db/download

# 4. Later — push a backup from your machine back to the server
curl -X POST http://localhost:8088/api/settings/db/backups/upload \
  -F 'file=@streamsnap-20260906-141200.db'

# 5. Restore it (replaces the live DB)
curl -X POST http://localhost:8088/api/settings/db/restore \
  -H 'Content-Type: application/json' \
  -d '{"name":"streamsnap-20260906-141200.db"}'
```

### `initialize_db` — the "clean slate" that keeps your setup

`POST /api/settings/db/initialize` deletes all `downloads`, `subscriptions`, `seen_videos`,
and `notifications` rows, in FK-safe order, and **unschedules every APScheduler job first**
so ghost subscriptions don't keep polling an empty DB. It **preserves** `notification_channels`
and `settings` — so you don't re-enter your SMTP password and yt-dlp defaults.

### Edge cases & best practices

- **Filename validation is strict**: `^[A-Za-z0-9._-]+$` and must end `.db`. Path traversal
  via `name` is blocked. Uploads that fail this get a `400`.
- **Restore is destructive and immediate** — there is no automatic pre-restore backup. Take
  a fresh `POST /db/backup` right before restoring an old one if the current state matters.
- **A restored backup can be an older schema version.** `init_db()` runs migrations at every
  startup, so restoring an old DB and restarting will migrate it forward — but restoring
  without a restart leaves the app running against an un-migrated schema until the next
  boot. **Restart after restoring a backup from a materially older version.**
- **Backups are never pruned.** `db-backups` grows until you delete files
  (`DELETE /api/settings/db/backups/{name}`). A SQLite DB for this app is tiny (KBs–MBs), so
  this is rarely a problem, but there's no retention policy.
- **The upload endpoint trusts the file is a real SQLite DB.** A malformed upload won't be
  caught until you try to restore it and the engine fails to open it.

### Security notes

- **A backup file is a complete credential dump.** It contains `notification_channels`
  (SMTP passwords, bot tokens, webhook URLs) and the `settings` table (yt-dlp `username` /
  `password` if you set them). Anyone who can hit `GET /db/backups/{name}/download` gets
  all of it. In the no-auth model, that's anyone who can reach the port.
- **Add `backups/` and `*.db` to `.gitignore`** (the repo already ignores `*.db`) so a local
  backup is never committed.
- The download endpoint serves with `media_type="application/octet-stream"` and a fixed
  `filename` — no user-controlled content-disposition.

---

## 5. Download activity meter (StatsMeter)

### What it does

A collapsible panel above the download list showing combined throughput across all active
downloads: a 60-second sparkline plus a one-line legend (current / peak / average speed,
count downloading, count queued, total completed bytes).

Source: `frontend/src/components/StatsMeter/index.tsx`, wired in
`frontend/src/pages/Dashboard/index.tsx`, toggled via `frontend/src/ui/UiPrefsContext.tsx`.

### Why it's built this way

- **Sampled, not event-driven.** A single `setInterval(..., 1000)` pushes the current
  combined speed into a fixed 60-element ring buffer once per second. Progress WebSocket
  events (~2/sec/download) update a `speedRef` but do **not** trigger a re-sample, so the
  graph stays a clean 1 Hz regardless of how many downloads are running or how chatty they
  are.
- **The sampler pauses itself when the tab is hidden** (`if (document.hidden) return;`
  inside the interval) — a background tab records a flat line rather than a misleading gap.
- **Y-axis auto-scales to the window peak** (`scale = peak * 1.1`), so the trace always
  fills the height whether you're pulling 200 KiB/s or 80 MiB/s. The current scale ceiling
  is printed as an axis label.
- **The speed value is held in a `useRef`**, so the 1 s interval effect is created once
  (`[]` deps) and never torn down / recreated on progress ticks.

### Persistence (per browser, `localStorage`)

| Key | Meaning |
|---|---|
| `streamsnap.statsMeter.open` | `"1"` / `"0"` — expanded or collapsed |
| `streamsnap.statsMeter.h` | chart height in px (desktop drag-resize), clamped 40–260 |
| `streamsnap.ui.v1` | the `statsMeter` on/off toggle + dashboard `sectionOrder` (via `useUiPrefs`) |

Height is written by a `ResizeObserver` on the resizable wrapper, **debounced 300 ms** so a
drag doesn't spam `localStorage`. Every read/write is wrapped in `try/catch` for private-mode
and quota failures.

### Example — the props contract

```tsx
{showStatsMeter && (
  <StatsMeter
    speedBps={downloadSpeedBps}   // sum of active-download speeds, bytes/sec
    downloading={activeCount}
    queued={queuedCount}
    completedBytes={doneBytes}    // sum of filesize over completed rows in the list
  />
)}
```

`showStatsMeter`, `sectionOrder`, and `moveSection` all come from `useUiPrefs()`.

### Edge cases & best practices

- **The graph is display-only and resets on reload** — the 60-point history is in React
  state, not persisted. That's deliberate; it's a "what's happening right now" widget.
- **`completedBytes` is only as good as the `filesize` yt-dlp reported.** Some extractors
  return `null` filesize; those rows contribute 0 to the "Done" figure.
- **Resize is desktop-only** — the CSS drops the `resize: vertical` affordance below the
  narrow breakpoint, and `chartH` falls back to the CSS default height.
- **Toggling the meter off** (`Settings → Theme → Interface`) unmounts the component
  entirely — the sampler interval stops, zero cost when hidden.
- If you add fields to the legend, keep the sampler at 1 Hz — the whole design depends on a
  fixed cadence decoupled from WebSocket volume.

---

## 6. yt-dlp updater

### What it does

A one-click "update yt-dlp to the latest PyPI release" that takes effect **without
restarting the server**, and — in Docker — **persists across container restarts** without
rebuilding the image.

Source: `backend/app/routes/settings.py` (`/ytdlp-version`, `/update-ytdlp`),
`backend/app/ytdl/loader.py`.

### Why it's built this way

yt-dlp breaks often (sites change), so updating it must be trivial and must not require a
redeploy. Two problems to solve:

**1. Persistence in Docker.** A `pip install --upgrade` inside a running container is lost
on the next `docker compose up`. Solution: install yt-dlp into `YTDLP_DIR` (`/ytdlp`, a
named volume), not into the image's site-packages. `ensure_on_path()` prepends that dir to
`sys.path` at startup so the volume copy always wins. The image ships a copy in
`/opt/ytdlp-seed`, and `docker-entrypoint.sh` seeds the empty volume from it on first run.

**2. Reloading a running process.** Once `import yt_dlp` has run, the modules are cached in
`sys.modules` and new files on disk are ignored. Solution: **every consumer imports
`yt_dlp` lazily** (inside the function that uses it), and after an update `reload_ytdlp()`
deletes every `yt_dlp*` entry from `sys.modules` and calls `importlib.invalidate_caches()`.
The next download re-imports from the new files.

> Note: the `update_ytdlp` docstring still mentions a `ProcessPoolExecutor` — the manager
> actually uses a `ThreadPoolExecutor`, and the `reload_ytdlp()` + lazy-import mechanism is
> what makes the in-process reload work. A fresh process would pick up the new version
> anyway.

### `_installed_version` vs `loaded_version`

`GET /api/settings/ytdlp-version` returns both:

```json
{ "version": "2026.09.01", "loaded_version": "2026.08.15", "ytdlp_dir": "/ytdlp" }
```

- `version` — read from `yt_dlp-*.dist-info/METADATA` **on disk** in `YTDLP_DIR`. This is
  the source of truth; it reflects the last successful update. `pip install --target`
  doesn't uninstall the old version, so multiple `dist-info` dirs can exist — the code
  picks the highest.
- `loaded_version` — what's currently in `sys.modules`. May lag `version` until the next
  download triggers the reload.

### What `POST /update-ytdlp` does

1. Record the old on-disk version.
2. If `YTDLP_DIR` is set: `_clean_target()` — wipe everything in it **except `db-backups`** —
   so no stale modules or `.dist-info` survive.
3. Run `pip install --no-cache-dir yt-dlp --target <YTDLP_DIR>` (or `pip install --upgrade
   yt-dlp` with no target, for local dev) as an async subprocess, **120 s timeout**.
4. Non-zero exit → `500` with the last 1000 chars of stderr. Timeout → `504`.
5. `reload_ytdlp()` — purge cached modules.
6. Return `{old_version, new_version, updated, ytdlp_dir}`.

### Example

```bash
curl http://localhost:8088/api/settings/ytdlp-version
curl -X POST http://localhost:8088/api/settings/update-ytdlp
# -> {"old_version":"2026.08.15","new_version":"2026.09.01","updated":true,"ytdlp_dir":"/ytdlp"}
```

To reset to the image's bundled version in Docker: `docker compose down` then
`docker volume rm streamsnap-ytdlp` (the entrypoint re-seeds it on next start).

### Edge cases & best practices

- **The update needs network egress to PyPI.** An air-gapped host can't use this button;
  bake the version you want into the image instead.
- **In-flight downloads keep the old version** until they finish — the reload only affects
  the *next* import. That's fine; it never swaps modules out from under a running download.
- **A failed update leaves you on the old version** *if* the `pip install` failed before
  writing files. But `_clean_target()` runs *before* the install — so a partial/failed
  install into `YTDLP_DIR` can leave it empty or half-populated. The entrypoint only
  re-seeds an *empty* dir on container start; a half-populated one won't self-heal. If an
  update fails hard, the safest recovery is to wipe the volume and restart.
- **`pip` here is `sys.executable -m pip`** — it uses the server's own Python. In a slim
  container without build tools, a yt-dlp release that needs to compile a dependency would
  fail; yt-dlp itself is pure Python, so this is rare.
- **Local dev updates your venv in place** (`--upgrade`, no `--target`). That changes the
  environment `pip install -e .` set up — fine, but know that it happened.

### Security notes

- This endpoint runs a subprocess (`pip`) on the host. It's a deliberate capability for the
  single-user model; behind shared access it is arbitrary-package-install-as-the-server.
- It installs from PyPI over HTTPS with pip's normal verification. It does **not** pin a
  hash or version — you get whatever `yt-dlp` resolves to at that moment.

---

## 7. Background themes

### What it does

An animated page backdrop chosen from **16 options**: "None", 5 WebGL effects (Net, Waves,
Cells, Dots, Rings — via Vanta + three.js), and 10 hand-written canvas effects (Aurora,
Starfield, Grid Pulse, Bubbles, Matrix Rain, Plasma, Mesh Gradient, Constellation, Neon
Lines, Snow). The choice is per-browser and theme-aware.

Source: `frontend/src/theme/Background.tsx`, `frontend/src/theme/customEffects.ts`,
`frontend/src/theme/ThemeContext.tsx`, `frontend/src/theme/types.ts`.

### Why it's built this way — the bundle-size rule

three.js is ~150 kB gzip. Loading it for everyone to power a background almost nobody
changes would be indefensible. So:

```ts
const loadThree = () => import("three").then(...);          // dynamic
const VANTA_LOADERS = { net: () => import("vanta/dist/vanta.net.min"), ... };  // dynamic
```

three.js and each Vanta module are **`import()`-ed on demand**, only when a WebGL effect is
actually selected. Users on "None" or any canvas effect never download them.

> **Never add a static `import ... from "three"` anywhere.** It re-inflates the main bundle
> by ~157 kB gzip and defeats the entire design.

### The shared canvas driver (`customEffects.ts`)

All 10 canvas effects subscribe to **one** `requestAnimationFrame` loop:

- **30 fps cap** (`FRAME_MS = 1000/30`) — ambient decoration doesn't need 60/120, and this
  roughly halves per-frame cost.
- **`MAX_BACKDROP_DPR = 1.5`** — the backing canvas is capped below the device pixel ratio.
  On a 4K/retina display the gradient-fill effects would otherwise paint 4× the pixels
  every frame.
- **Auto-stop conditions** (`driverShouldRun()`): no subscribers, OR `document.hidden`, OR
  `setEffectsPaused(true)`. When none run, the rAF loop is fully cancelled — **zero cost**
  while it can't be seen.
- **`prefers-reduced-motion: reduce`** → the `loop()` helper paints **one** representative
  frame and never schedules another.

`App.tsx` passes `paused={settingsOpen}` to `<Background>`, so opening the Settings modal
freezes the backdrop (`setEffectsPaused(true)`). For Vanta there is no cheap pause, so
`Background.tsx` simply **doesn't mount** a WebGL instance while `paused` or `reduced` is
true, and destroys it on unmount (with a workaround for Vanta leaving its `<canvas>` behind).

### Theme awareness

`vantaOptions(id, mode, THREE)` swaps colours by `mode`: background `#0A0A0B` / `#F5F5F9`,
accent `#7C5CFF` / `#5A3FFF`, plus per-effect tuning. Canvas effect factories take
`(canvas, mode)` and pick their own palette. Changing the light/dark toggle re-runs the
effect's `useEffect` (mode is a dependency) and remounts it with the new colours.

### Persistence

`ThemeContext` persists `{ mode, background }` as JSON under `localStorage` key
`streamsnap.theme.v1`, and reflects `mode` onto `<html data-theme="...">` so the CSS token
layer swaps. Reads fall back to `DEFAULT_THEME` on any parse/quota error.

### Example — add an 11th canvas effect

```ts
// 1. frontend/src/theme/types.ts — add the id
{ id: "embers", label: "Embers", group: "Custom" },

// 2. frontend/src/theme/customEffects.ts — register a factory that uses the
//    shared helpers (NOT its own requestAnimationFrame)
const embers: Factory = (canvas, mode) => {
  const teardownResize = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const stop = loop((t) => {
    // ...draw one frame at time t using ctx...
  });
  return { destroy: () => { stop(); teardownResize(); } };
};

// 3. add `embers` to the factory registry object in the same file
```

The picker UI in `Settings → Theme` is data-driven from the `types.ts` list — no other
wiring needed.

### Edge cases & best practices

- **A new effect that calls `requestAnimationFrame` directly bypasses every safeguard** —
  the 30 fps cap, the tab-hidden stop, the reduced-motion freeze, the modal pause. Always
  build on `loop()` + `setupCanvas()`.
- **Vanta version drift.** `vanta@0.5.24` / `three@0.134.0` are pinned in `package.json`;
  Vanta is sensitive to the three.js version. Bumping either without testing all five WebGL
  effects will likely break one silently.
- **`@ts-expect-error vanta has no types`** precedes each Vanta import — if Vanta ever ships
  types, those comments become errors and must be removed.
- **`localStorage` can be unavailable** (private mode, embedded webviews). Every access is
  guarded; the app renders the default theme rather than crashing.
- **WebGL can be disabled or blocklisted** on some GPUs/drivers. If a Vanta effect fails to
  initialise the page just shows no background — there is no error surface. Canvas effects
  are the safe default for broad hardware.
- The backdrop is `aria-hidden="true"` and purely decorative — keep it that way; nothing
  functional should ever live in `Background.tsx`.

### Security notes

- Vanta and three.js are the only runtime frontend dependencies that execute non-trivial
  logic. Keep them pinned and review changelogs before bumping.
- Effects render to a detached canvas with no user input and no network access — no risk
  surface beyond the dependency itself.

---

## Appendix: REST API Reference

Base URL `http://<host>:8088`. Every path below is served under `/api` except `/health`.
Responses are JSON; `2xx` on success, `4xx`/`5xx` with `{"detail": "..."}` on error.

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
| `POST` | `/api/subscriptions` | Create (with `download_existing`, `download_video_ids`) |
| `GET` | `/api/subscriptions` | List |
| `GET` | `/api/subscriptions/{id}` | Get one |
| `PATCH` | `/api/subscriptions/{id}` | Update interval / format / template / active / notify |
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
