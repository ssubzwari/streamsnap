import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "@/components/FolderPicker";
import { downloadUrl, type OpResult } from "@/api/files";
import {
  createMediaFolder,
  deleteMedia,
  errorText,
  listMedia,
  listMediaRoots,
  renameMedia,
  transferMedia,
  type MediaEntry,
  type MediaListing,
  type MediaRoot,
} from "@/api/media";
import { getOpenIn } from "@/player/openPreference";
import { usePlayer, type Track } from "@/player/PlayerContext";
import { addedNote, useFlashNote } from "@/player/useFlashNote";

import DestDialog from "./DestDialog";
import Group from "./Group";
import {
  DOWNLOADS_ROOT,
  NO_STREAM_NOTE,
  baseName,
  readStored,
  trackFor,
  writeStored,
  type Mods,
} from "./shared";
import styles from "./MediaManager.module.css";

const TILE_KEY = "streamsnap.media.tile.v1";
const COLLAPSED_KEY = "streamsnap.media.collapsed.v1";
const TILE_MIN = 96;
const TILE_MAX = 280;
const TILE_DEFAULT = 150;
const RECENT_MS = 7 * 24 * 3600 * 1000;
const MAX_GROUPS = 60;

type KindFilter = "all" | "video" | "audio" | "other";
type ShowFilter = "everything" | "notInPlaylist" | "recent";
type SortKey = "name" | "date" | "size";

const KINDS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "other", label: "Other" },
];

const SHOWS: { key: ShowFilter; label: string }[] = [
  { key: "everything", label: "Everything" },
  { key: "notInPlaylist", label: "Not in playlist" },
  { key: "recent", label: "Recently added" },
];

type DialogState =
  | { kind: "move" | "copy"; items: string[] }
  | { kind: "rename"; entry: MediaEntry }
  | { kind: "newFolder" }
  | { kind: "delete"; items: MediaEntry[] }
  | null;

type Status = { kind: "info" | "error"; text: string } | null;

function summarize(results: OpResult[], verb: string): Status {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { kind: "info", text: `${verb} ${ok} item${ok === 1 ? "" : "s"}.` };
  const detail = failed.map((r) => `${baseName(r.path)} (${r.error ?? "failed"})`).join("; ");
  return { kind: ok > 0 ? "info" : "error", text: `${verb} ${ok}. Skipped ${failed.length}: ${detail}` };
}

const parentOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export default function MediaManager() {
  const player = usePlayer();
  const [note, flash] = useFlashNote();

  const [roots, setRoots] = useState<MediaRoot[] | null>(null);
  const [rootId, setRootId] = useState(DOWNLOADS_ROOT);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<MediaListing | null>(null);
  const [children, setChildren] = useState<Record<string, MediaEntry[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [show, setShow] = useState<ShowFilter>("everything");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [tile, setTile] = useState<number>(() => {
    const v = readStored<number>(TILE_KEY, TILE_DEFAULT);
    return typeof v === "number" && v >= TILE_MIN && v <= TILE_MAX ? v : TILE_DEFAULT;
  });
  const [listView, setListView] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readStored(COLLAPSED_KEY, {}));

  const [dialog, setDialog] = useState<DialogState>(null);
  const [nameInput, setNameInput] = useState("");
  const loadSeq = useRef(0);

  const load = useCallback(async (root: string, target: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const next = await listMedia(root, target);
      const dirs = next.entries.filter((e) => e.is_dir).slice(0, MAX_GROUPS);
      const kids = await Promise.all(
        dirs.map((d) =>
          listMedia(root, d.path).then(
            (l) => [d.path, l.entries] as const,
            () => [d.path, [] as MediaEntry[]] as const,
          ),
        ),
      );
      if (seq !== loadSeq.current) return;
      setListing(next);
      setChildren(Object.fromEntries(kids));
      setPath(next.path);
      setRootId(root);
      setLoadError(null);
      setSelected(new Set());
      setAnchor(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  const refreshRoots = useCallback(async () => {
    try {
      setRoots(await listMediaRoots());
    } catch (e) {
      setStatus({ kind: "error", text: `Could not load media folders: ${errorText(e)}` });
    }
  }, []);

  useEffect(() => {
    void refreshRoots();
    void load(DOWNLOADS_ROOT, "");
  }, [refreshRoots, load]);

  const refresh = () => {
    void refreshRoots();
    void load(rootId, path);
  };

  const queueKeys = useMemo(() => new Set(player.queue.map((t) => t.key)), [player.queue]);
  const currentRoot = roots?.find((r) => r.id === rootId) ?? null;
  const rootLabel = currentRoot?.label ?? (rootId === DOWNLOADS_ROOT ? "Downloads" : "Folder");

  const isPlayable = useCallback((e: MediaEntry) => trackFor(e, rootId) !== null, [rootId]);

  // ── what is visible ──
  const needle = search.trim().toLowerCase();
  const filtering = needle !== "" || kind !== "all" || show !== "everything";

  const view = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    const cmp = (a: MediaEntry, b: MediaEntry): number => {
      if (sortKey === "date") return dir * a.modified.localeCompare(b.modified);
      if (sortKey === "size") return dir * ((a.size ?? 0) - (b.size ?? 0));
      return dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    };
    const nameMatches = (e: MediaEntry) => needle === "" || e.name.toLowerCase().includes(needle);
    const fileOk = (e: MediaEntry, ignoreSearch: boolean): boolean => {
      if (!ignoreSearch && !nameMatches(e)) return false;
      if (kind !== "all" && e.kind !== kind) return false;
      if (show === "recent") return Date.now() - Date.parse(e.modified) < RECENT_MS;
      if (show === "notInPlaylist") {
        const t = trackFor(e, rootId);
        return !t || !queueKeys.has(t.key);
      }
      return true;
    };
    const filesOf = (entries: MediaEntry[], ignoreSearch: boolean) =>
      entries.filter((e) => !e.is_dir && fileOk(e, ignoreSearch)).sort(cmp);

    const all = listing?.entries ?? [];
    const groups = all
      .filter((e) => e.is_dir)
      .sort(cmp)
      .map((folder) => {
        const kids = children[folder.path] ?? [];
        const selfMatch = needle !== "" && nameMatches(folder);
        const files = filesOf(kids, selfMatch);
        const subfolders = kids.filter((k) => k.is_dir && nameMatches(k)).sort(cmp);
        const plainFilterOnly = kind === "all" && show === "everything";
        const visible = !filtering || files.length > 0 || (selfMatch && plainFilterOnly);
        return { folder, kids, files, subfolders, visible };
      })
      .filter((g) => g.visible);
    const loose = filesOf(all, false);
    const flat: MediaEntry[] = [...groups.flatMap((g) => [g.folder, ...g.files]), ...loose];
    return { groups, loose, flat };
  }, [listing, children, needle, kind, show, sortKey, sortAsc, filtering, queueKeys, rootId]);

  const lookup = useMemo(() => {
    const m = new Map<string, MediaEntry>();
    for (const e of listing?.entries ?? []) m.set(e.path, e);
    for (const list of Object.values(children)) for (const e of list) m.set(e.path, e);
    return m;
  }, [listing, children]);

  const flatIndex = useMemo(() => new Map(view.flat.map((e, i) => [e.path, i])), [view.flat]);

  const selectedEntries = useMemo(
    () =>
      Array.from(selected)
        .map((p) => lookup.get(p))
        .filter((e): e is MediaEntry => !!e)
        .sort((a, b) => (flatIndex.get(a.path) ?? 1e9) - (flatIndex.get(b.path) ?? 1e9)),
    [selected, lookup, flatIndex],
  );
  const selectedFiles = selectedEntries.filter((e) => !e.is_dir);
  const selectedFolders = selectedEntries.filter((e) => e.is_dir);
  /** Selected paths minus anything already inside a selected folder (moving both would fail). */
  const topLevel = useMemo(() => {
    const folders = selectedFolders.map((f) => f.path);
    return selectedEntries.filter((e) => !folders.some((f) => e.path !== f && e.path.startsWith(`${f}/`)));
  }, [selectedEntries, selectedFolders]);

  // ── selection ──
  const toggle = (entry: MediaEntry) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    setAnchor(flatIndex.get(entry.path) ?? null);
  };

  const selectAll = () => {
    const allPaths = view.flat.map((e) => e.path);
    setSelected(selected.size === allPaths.length ? new Set() : new Set(allPaths));
  };

  // ── playback ──
  const tracksOf = (entries: MediaEntry[]): { tracks: Track[]; skipped: number } => {
    const tracks: Track[] = [];
    let skipped = 0;
    const take = (e: MediaEntry) => {
      const t = trackFor(e, rootId);
      if (t) tracks.push(t);
      else if (e.kind === "audio" || e.kind === "video") skipped += 1;
    };
    for (const e of entries) {
      if (e.is_dir) (children[e.path] ?? []).filter((k) => !k.is_dir).forEach(take);
      else take(e);
    }
    return { tracks, skipped };
  };

  const skipNote = (skipped: number) => (skipped > 0 ? ` (${skipped} skipped: ${NO_STREAM_NOTE})` : "");

  const playEntries = (entries: MediaEntry[]) => {
    const { tracks, skipped } = tracksOf(entries);
    if (tracks.length === 0) {
      flash(skipped > 0 ? NO_STREAM_NOTE : "Nothing playable here.");
      return;
    }
    player.playList(tracks, 0);
    if (skipped > 0) flash(`Playing ${tracks.length}${skipNote(skipped)}`);
  };

  const addEntries = (entries: MediaEntry[]) => {
    const { tracks, skipped } = tracksOf(entries);
    if (tracks.length === 0) {
      flash(skipped > 0 ? NO_STREAM_NOTE : "Nothing to add here.");
      return;
    }
    player.addTracks(tracks);
    flash(addedNote(tracks.length) + skipNote(skipped));
  };

  const playOne = (entry: MediaEntry) => {
    const track = trackFor(entry, rootId);
    if (!track) {
      flash(entry.kind === "audio" || entry.kind === "video" ? NO_STREAM_NOTE : `${entry.name} is not an audio or video file.`);
      return;
    }
    if (getOpenIn() === "tab") window.open(track.src, "_blank");
    else player.playList([track], 0);
  };

  const onTileClick = (mods: Mods, entry: MediaEntry) => {
    const index = flatIndex.get(entry.path) ?? -1;
    if (mods.shiftKey && anchor !== null) {
      const [lo, hi] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(view.flat.slice(lo, hi + 1).filter((e) => !e.is_dir).map((e) => e.path)));
    } else if (mods.ctrlKey || mods.metaKey) toggle(entry);
    else playOne(entry);
  };

  // ── mutations ──
  const run = async (task: () => Promise<Status>) => {
    setBusy(true);
    try {
      setStatus(await task());
      await load(rootId, path);
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const doTransfer = (items: string[], destRoot: string, dest: string, mode: "move" | "copy") => {
    setDialog(null);
    void run(async () => summarize(await transferMedia(rootId, items, destRoot, dest, mode), mode === "move" ? "Moved" : "Copied"));
  };

  const doDelete = (items: MediaEntry[]) => {
    setDialog(null);
    void run(async () => summarize(await deleteMedia(rootId, items.map((e) => e.path)), "Deleted"));
  };

  const doRename = (entry: MediaEntry) => {
    const name = nameInput.trim();
    if (!name) return;
    setDialog(null);
    void run(async () => {
      await renameMedia(rootId, entry.path, name);
      return { kind: "info", text: `Renamed to ${name}.` };
    });
  };

  const doNewFolder = () => {
    const name = nameInput.trim();
    if (!name) return;
    setDialog(null);
    void run(async () => {
      await createMediaFolder(rootId, path, name);
      return { kind: "info", text: `Created ${name}.` };
    });
  };

  const openDialog = (next: DialogState) => {
    setNameInput(next?.kind === "rename" ? next.entry.name : "");
    setDialog(next);
  };

  const downloadable = rootId === DOWNLOADS_ROOT;
  // One file per download, spaced out: browsers block a burst of automatic downloads.
  const downloadSelected = () => {
    selectedFiles.forEach((e, i) => {
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = downloadUrl(e.path);
        a.download = e.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 700);
    });
    const skipped = selectedFolders.length > 0 ? `, skipped ${selectedFolders.length} folder(s)` : "";
    flash(`Downloading ${selectedFiles.length} file(s)${skipped}`);
  };

  // Escape closes the open dialog, otherwise clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialog) setDialog(null);
      else setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  // ── collapse ──
  const collapseKey = (p: string) => `${rootId}:${p}`;
  const isCollapsed = (p: string, fallback: boolean) => !filtering && (collapsed[collapseKey(p)] ?? fallback);
  const toggleCollapse = (p: string, fallback: boolean) => {
    const next = { ...collapsed, [collapseKey(p)]: !(collapsed[collapseKey(p)] ?? fallback) };
    setCollapsed(next);
    writeStored(COLLAPSED_KEY, next);
  };

  const setTileSize = (v: number) => {
    setTile(v);
    writeStored(TILE_KEY, v);
  };

  const crumbs = path ? path.split("/") : [];
  const looseTitle = path ? `Files in ${baseName(path)}` : `Loose files (${rootLabel})`;
  const nothingToShow = !!listing && view.groups.length === 0 && view.loose.length === 0;
  const emptyFolder = !!listing && listing.entries.length === 0;

  return (
    <div className={styles.page}>
      <aside className={styles.side}>
        <h4 className={styles.sideHead}>Media folders</h4>
        {!roots && <div className={styles.hint}>Loading folders…</div>}
        {roots?.map((r) => (
          <button
            key={r.id}
            className={`${styles.node} ${r.id === rootId ? styles.nodeSel : ""}`}
            disabled={!r.available}
            onClick={() => load(r.id, "")}
            title={r.path}
          >
            <span className={styles.nodeLabel}>{r.label}</span>
            {r.available ? (
              <span className={styles.nodeCount}>{r.file_count}</span>
            ) : (
              <span className={styles.nodeNote}>unavailable</span>
            )}
          </button>
        ))}
        {roots?.some((r) => !r.available) && (
          <div className={styles.hint}>Unavailable folders are missing or not mounted on the server.</div>
        )}
        <h4 className={styles.sideHead}>Show</h4>
        {SHOWS.map((s) => (
          <button
            key={s.key}
            className={`${styles.node} ${show === s.key ? styles.nodeSel : ""}`}
            onClick={() => setShow(s.key)}
          >
            <span className={styles.nodeLabel}>{s.label}</span>
          </button>
        ))}
      </aside>

      <section className={styles.main}>
        <div className={styles.toolbar}>
          <input
            className={styles.search}
            type="search"
            placeholder="Search files and folders…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search files and folders"
          />
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`${styles.chip} ${kind === k.key ? styles.chipOn : ""}`}
              onClick={() => setKind(k.key)}
            >
              {k.label}
            </button>
          ))}
          <select className={styles.select} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sort by">
            <option value="name">Sort: Name</option>
            <option value="date">Sort: Date</option>
            <option value="size">Sort: Size</option>
          </select>
          <button
            className={styles.chip}
            onClick={() => setSortAsc(!sortAsc)}
            aria-label={sortAsc ? "Ascending" : "Descending"}
            title={sortAsc ? "Ascending" : "Descending"}
          >
            {sortAsc ? "↑" : "↓"}
          </button>
          <label className={styles.slider}>
            Size
            <input
              type="range"
              min={TILE_MIN}
              max={TILE_MAX}
              step={4}
              value={tile}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Tile size"
            />
          </label>
          <button className={`${styles.chip} ${!listView ? styles.chipOn : ""}`} onClick={() => setListView(false)}>Grid</button>
          <button className={`${styles.chip} ${listView ? styles.chipOn : ""}`} onClick={() => setListView(true)}>List</button>
        </div>

        <div className={styles.crumbRow}>
          <nav className={styles.crumbs} aria-label="Folder path">
            <button className={styles.linkBtn} onClick={() => load(rootId, "")}>{rootLabel}</button>
            {crumbs.map((part, i) => (
              <span key={`${part}-${i}`}>
                {" / "}
                <button className={styles.linkBtn} onClick={() => load(rootId, crumbs.slice(0, i + 1).join("/"))}>{part}</button>
              </span>
            ))}
          </nav>
          <span className={styles.spacer} />
          {path !== "" && (
            <button className={styles.btn} onClick={() => load(rootId, listing?.parent ?? parentOf(path))} disabled={busy}>↰ Up</button>
          )}
          <button className={styles.btn} onClick={selectAll} disabled={view.flat.length === 0}>
            {selected.size > 0 && selected.size === view.flat.length ? "Deselect all" : "Select all"}
          </button>
          <button className={styles.btn} onClick={() => openDialog({ kind: "newFolder" })} disabled={busy || !currentRoot?.available}>New folder</button>
          <button className={styles.btn} onClick={refresh} disabled={busy || loading}>Refresh</button>
        </div>

        {note && <div className={styles.status} role="status">{note}</div>}
        {status && (
          <div className={status.kind === "error" ? styles.statusError : styles.status} role="status">
            <span>{status.text}</span>
            <button className={styles.statusClose} onClick={() => setStatus(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        {loadError && (
          <div className={styles.statusError} role="alert">
            <span>Could not open this folder: {loadError}</span>
            <button className={styles.btn} onClick={refresh}>Retry</button>
          </div>
        )}
        {loading && !listing && !loadError && <div className={styles.empty}>Loading…</div>}
        {emptyFolder && !loadError && <div className={styles.empty}>This folder is empty.</div>}
        {nothingToShow && !emptyFolder && <div className={styles.empty}>Nothing matches the current search and filters.</div>}

        <div
          className={`${styles.groups} ${listView ? styles.listView : ""}`}
          style={{ "--tile-min": `${tile}px` } as React.CSSProperties}
        >
          {view.groups.map((g) => (
            <Group
              key={g.folder.path}
              title={g.folder.name}
              folder={g.folder}
              count={g.kids.length}
              collapsed={isCollapsed(g.folder.path, true)}
              files={g.files}
              subfolders={g.subfolders}
              selected={selected}
              isPlayable={isPlayable}
              onToggleCollapse={() => toggleCollapse(g.folder.path, true)}
              onToggleSelect={toggle}
              onTileClick={onTileClick}
              onAddOne={(e) => addEntries([e])}
              onOpenFolder={(f) => load(rootId, f.path)}
              onPlayFolder={(f) => playEntries([f])}
              onAddFolder={(f) => addEntries([f])}
              onRenameFolder={(f) => openDialog({ kind: "rename", entry: f })}
              onMoveFolder={(f) => openDialog({ kind: "move", items: [f.path] })}
            />
          ))}
          {view.loose.length > 0 && (
            <Group
              title={looseTitle}
              folder={null}
              count={view.loose.length}
              collapsed={isCollapsed(`${path}\u0000loose`, false)}
              files={view.loose}
              subfolders={[]}
              selected={selected}
              isPlayable={isPlayable}
              onToggleCollapse={() => toggleCollapse(`${path}\u0000loose`, false)}
              onToggleSelect={toggle}
              onTileClick={onTileClick}
              onAddOne={(e) => addEntries([e])}
              onOpenFolder={(f) => load(rootId, f.path)}
              onPlayFolder={(f) => playEntries([f])}
              onAddFolder={(f) => addEntries([f])}
              onRenameFolder={(f) => openDialog({ kind: "rename", entry: f })}
              onMoveFolder={(f) => openDialog({ kind: "move", items: [f.path] })}
            />
          )}
        </div>

        <div className={styles.hint}>
          Click a file to play it. Ctrl+click or the checkbox selects; Shift+click selects a range; Esc clears the selection.
        </div>

        {selected.size > 0 && (
          <div className={styles.bar} role="toolbar" aria-label="Selection actions">
            <strong>{selected.size} selected</strong>
            <span className={styles.spacer} />
            <button className={styles.btn} onClick={() => playEntries(selectedEntries)}>▶ Play</button>
            <button className={styles.btn} onClick={() => addEntries(selectedEntries)}>+ Playlist</button>
            <button className={styles.btn} onClick={() => openDialog({ kind: "move", items: topLevel.map((e) => e.path) })} disabled={busy}>Move…</button>
            <button className={styles.btn} onClick={() => openDialog({ kind: "copy", items: topLevel.map((e) => e.path) })} disabled={busy}>Copy…</button>
            {selectedEntries.length === 1 && (
              <button className={styles.btn} onClick={() => openDialog({ kind: "rename", entry: selectedEntries[0] })} disabled={busy}>Rename</button>
            )}
            <button
              className={styles.btn}
              onClick={downloadSelected}
              disabled={busy || selectedFiles.length === 0 || !downloadable}
              title={downloadable ? "Download the selected files one by one" : "The server can only send files from Downloads; extra media folders have no download endpoint."}
            >
              Download
            </button>
            <button className={`${styles.btn} ${styles.danger}`} onClick={() => openDialog({ kind: "delete", items: topLevel })} disabled={busy}>Delete</button>
            <button className={styles.btn} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
      </section>

      {dialog && (dialog.kind === "move" || dialog.kind === "copy") && roots && (
        <DestDialog
          title={`${dialog.kind === "move" ? "Move" : "Copy"} ${dialog.items.length} item${dialog.items.length === 1 ? "" : "s"} to…`}
          confirmLabel={dialog.kind === "move" ? "Move here" : "Copy here"}
          roots={roots}
          initialRoot={rootId}
          initialPath={path}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(root, dest) => doTransfer(dialog.items, root, dest, dialog.kind as "move" | "copy")}
        />
      )}

      {dialog && (dialog.kind === "rename" || dialog.kind === "newFolder") && (
        <Dialog title={dialog.kind === "rename" ? "Rename" : "New folder"} onClose={() => setDialog(null)}>
          <div className={styles.dialogBody}>
            <input
              className={styles.input}
              autoFocus
              value={nameInput}
              placeholder={dialog.kind === "newFolder" ? "Folder name" : "New name"}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (dialog.kind === "rename") doRename(dialog.entry);
                else doNewFolder();
              }}
            />
            <div className={styles.dialogFoot}>
              <button className={styles.btn} onClick={() => setDialog(null)}>Cancel</button>
              <button
                className={`${styles.btn} ${styles.primary}`}
                disabled={!nameInput.trim()}
                onClick={() => (dialog.kind === "rename" ? doRename(dialog.entry) : doNewFolder())}
              >
                {dialog.kind === "rename" ? "Rename" : "Create"}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {dialog && dialog.kind === "delete" && (
        <Dialog title="Delete permanently?" onClose={() => setDialog(null)}>
          <div className={styles.dialogBody}>
            <p>
              Permanently delete {dialog.items.filter((e) => !e.is_dir).length} file(s) and{" "}
              {dialog.items.filter((e) => e.is_dir).length} folder(s) from disk:
            </p>
            <ul className={styles.deleteList}>
              {dialog.items.map((e) => (
                <li key={e.path}>{e.is_dir ? `📁 ${e.name} (folder and everything in it)` : e.name}</li>
              ))}
            </ul>
            <p className={styles.errorText}>This can't be undone. Download entries for deleted files stay in the history but lose their file.</p>
            <div className={styles.dialogFoot}>
              <button className={styles.btn} onClick={() => setDialog(null)}>Cancel</button>
              <button className={`${styles.btn} ${styles.primary} ${styles.dangerPrimary}`} onClick={() => doDelete(dialog.items)} disabled={busy}>
                Delete
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
