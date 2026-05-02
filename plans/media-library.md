# Plan: Plex-Inspired Media Library Tab

## Context
User wants MetubePlus to feel like Plex — a proper media library, not just a download queue. Two new capabilities:
1. Tag downloads as Movies / TV / Music at submission time
2. A "Media" tab showing completed downloads as a poster-card grid, filterable by category

The app currently has no routing and a single Dashboard page. The design must match the existing dark premium aesthetic (tokens.css, CSS Modules, Plus Jakarta Sans).

---

## Architecture Decisions

- **No react-router** — `activeTab` state in `App.tsx` is the entire nav layer
- **Self-fetching Media page** — calls `listDownloads()` itself (avoids lifting all download state to App), listens to WS for live completion events
- **`media_category`** stored as `VARCHAR` in SQLite: values `"movies"` | `"tv"` | `"music"` | `null`
- **Null-safe** — downloads made before this feature have `media_category = null`; they appear in "All" but not in category filters

---

## Implementation Order

### Phase 1 — Backend (no frontend impact)

**`backend/app/models.py`**
- Add `media_category: Mapped[str | None] = mapped_column(String, nullable=True)` to `Download` after `acodec`

**`backend/app/schemas.py`**
- Add `media_category: str | None = None` to both `DownloadCreateRequest` and `DownloadInfo`

**`backend/app/db.py`**
- Add idempotent migration block inside `init_db()` (follow existing pattern for `notify`/`thumbnail` columns):
  ```python
  dl_cols = await conn.run_sync(lambda c: _existing_cols(c, "downloads"))
  if "media_category" not in dl_cols:
      await conn.execute(text("ALTER TABLE downloads ADD COLUMN media_category VARCHAR"))
  ```

**`backend/app/routes/downloads.py`**
- In `create_download()`: pass `media_category=req.media_category` to `Download(...)` constructor
- In `download_playlist()`: extend `PlaylistDownloadRequest` with `media_category: str | None = None`; pass through to each `Download(...)` constructor in the loop

---

### Phase 2 — Frontend types (no UI change)

**`frontend/src/ws/events.ts`**
- Add `media_category: string | null;` to `DownloadInfo` interface (after `subscription_id`)

**`frontend/src/api/downloads.ts`**
- Add `media_category?: string;` to `CreateDownloadRequest`
- Extend `downloadPlaylist` to accept optional `media_category?: string` third param, include in POST body

---

### Phase 3 — Category dropdown in download form

**`frontend/src/pages/Dashboard/index.tsx`**
- Add state: `const [mediaCategory, setMediaCategory] = useState<string>("none");`
- Inside the existing `<div className={styles.formatRow}>`, append after Quality dropdown:
  ```tsx
  <label className={styles.dropdownLabel}>
    Category
    <select className={styles.dropdown} value={mediaCategory} onChange={e => setMediaCategory(e.target.value)}>
      <option value="none">None</option>
      <option value="movies">Movie</option>
      <option value="tv">TV Show</option>
      <option value="music">Music</option>
    </select>
  </label>
  ```
- In `handleDownload()`, pass `media_category: mediaCategory !== "none" ? mediaCategory : undefined` to `createDownload()`
- Same for playlist path → pass to `downloadPlaylist()`

---

### Phase 4 — New components (additive)

**NEW `frontend/src/components/MediaCard/index.tsx`**
- Props: `download: DownloadInfo`
- Layout: poster container (2:3 aspect ratio) + meta row below
- Poster: `<img>` if `thumbnail` exists, else SVG placeholder icon
- Hover overlay: semi-transparent bg + accent-colored circular play button (scale from 0.85 → 1)
- Category badge: top-left, frosted-glass style (`backdrop-filter: blur`)
- Click: calls `openDownload(d.id)` (existing `/api/downloads/{id}/open` endpoint)
- Keyboard: `tabIndex={0}` + Enter key handler

**NEW `frontend/src/components/MediaCard/MediaCard.module.css`**
- `.card` → `cursor: pointer`, focus ring via `box-shadow: 0 0 0 2px var(--color-accent)` on `:focus-visible`
- `.poster` → `aspect-ratio: 2/3`, `overflow: hidden`, `border-radius: var(--radius-md)`
- `.posterImg` → `object-fit: cover`, `transform: scale(1.04)` on `.card:hover`
- `.overlay` → `opacity: 0` → `opacity: 1` on hover, with play button scaling
- `.badge` → absolute top-left, `backdrop-filter: blur(4px)`, uppercase xs text
- `.title` → `text-overflow: ellipsis`, `white-space: nowrap`

**NEW `frontend/src/pages/Media/index.tsx`**
- Self-fetches completed downloads via `listDownloads()` on mount, filtered to `status === "completed"`
- Listens to `DOWNLOAD_COMPLETED` WS event to add items live; `DOWNLOAD_CANCELED` to remove
- Filter state: `"all" | "movies" | "tv" | "music"`
- Filter bar: pill buttons with count badge (`color-mix` tinted bg for count, accent bg on active)
- Grid: `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`, gap `var(--space-4)`
- Loading state: 8 skeleton cards (`aspect-ratio: 2/3`, pulse animation)
- Empty state: icon + message per category

**NEW `frontend/src/pages/Media/Media.module.css`**
- `.page` → `padding: var(--space-5)`, `max-width: 1400px`, centered
- `.filterBtn` → surface bg, border, transitions to accent on active
- `.filterCount` → `color-mix(in srgb, currentColor 15%, transparent)` bg, pill shape
- `.skeletonCard` → `aspect-ratio: 2/3`, pulse keyframe animation

---

### Phase 5 — App shell refactor

**`frontend/src/App.tsx`**
- Add `const [activeTab, setActiveTab] = useState<"downloader" | "media">("downloader")`
- `settingsOpen` state lifted to App.tsx; gear button in nav calls `setSettingsOpen(true)`
- Dashboard accepts `settingsOpen: boolean` + `onCloseSettings: () => void` props
- Stats (active count, speed) reported up via optional callbacks

**NEW `frontend/src/App.module.css`**
- `.shell` → `min-height: 100vh`, flex column
- `.topNav` → `height: 48px`, sticky top 0, `z-index: 10`, surface bg, border-bottom
- `.tab` → ghost button, muted color, `--dur-fast` transition
- `.tabActive` → text color + surface-hi bg + `::after` underline pill in accent color (`bottom: -1px`, `height: 2px`)
- `.navRight` → `margin-left: auto`, flex row for stats badge + settings button

**`frontend/src/pages/Dashboard/index.tsx`**
- Remove the `<header>` block (brand, stats badge, settings button) — now owned by App.tsx
- Accept `settingsOpen: boolean` + `onCloseSettings: () => void` props
- Report active count and speed up via optional callback props

---

## Critical Files

| File | Change |
|---|---|
| `backend/app/models.py` | Add `media_category` column |
| `backend/app/schemas.py` | Add field to request + response |
| `backend/app/db.py` | Idempotent ALTER TABLE migration |
| `backend/app/routes/downloads.py` | Thread field through create + playlist |
| `frontend/src/ws/events.ts` | Add field to DownloadInfo |
| `frontend/src/api/downloads.ts` | Add field to CreateDownloadRequest |
| `frontend/src/pages/Dashboard/index.tsx` | Category dropdown + remove header |
| `frontend/src/App.tsx` | Tab state + top nav + conditional render |
| `frontend/src/App.module.css` | NEW — nav styles |
| `frontend/src/pages/Media/index.tsx` | NEW — library page |
| `frontend/src/pages/Media/Media.module.css` | NEW — library styles |
| `frontend/src/components/MediaCard/index.tsx` | NEW — poster card |
| `frontend/src/components/MediaCard/MediaCard.module.css` | NEW — card styles |

---

## Verification

1. Start backend: `cd backend && .venv/Scripts/activate && uvicorn app.main:app --reload --port 8088`
2. Start frontend: `cd frontend && npm run dev`
3. Open `http://localhost:5173` — verify two tabs appear in nav (Downloader / Media)
4. In Downloader tab: submit a URL, select "Movie" from Category dropdown → download completes
5. Switch to Media tab → card appears in grid under Movies filter with thumbnail poster
6. Hover the card → overlay + play button animate in; click → file opens in OS
7. Submit a second URL with "TV Show" category → appears under TV filter only
8. Verify "All" filter shows both; "Music" filter shows empty state with correct message
9. Run `tsc -b` in frontend — zero type errors
