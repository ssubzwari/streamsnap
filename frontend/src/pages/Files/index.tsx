import { useCallback, useEffect, useState } from "react";

import { Dialog, FolderBrowser } from "@/components/FolderPicker";
import { openFileRow } from "@/player/openMedia";
import { fileTrack, isMediaFile, mediaKindFromName, usePlayer } from "@/player/PlayerContext";
import { addedNote, useFlashNote } from "@/player/useFlashNote";
import {
  createFolder,
  deleteItems,
  downloadUrl,
  listFolder,
  renameItem,
  transferItems,
  type FileEntry,
  type FolderListing,
  type OpResult,
} from "@/api/files";

import styles from "./Files.module.css";

const DRAG_TYPE = "application/x-streamsnap-items";

type DialogState =
  | { kind: "move" | "copy" }
  | { kind: "rename" }
  | { kind: "newFolder" }
  | { kind: "delete" }
  | null;

const formatError = (e: unknown): string => {
  const raw = String(e).replace(/^ApiError: /, "");
  try {
    const body = JSON.parse(raw);
    if (body?.detail) return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {}
  return raw;
};

const formatSize = (bytes: number | null): string => {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const baseName = (rel: string): string => rel.split("/").pop() ?? rel;

function summarize(results: OpResult[], verb: string): { kind: "info" | "error"; text: string } {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { kind: "info", text: `${verb} ${ok} item${ok === 1 ? "" : "s"}.` };
  const detail = failed.map((r) => `${baseName(r.path)} (${r.error ?? "failed"})`).join("; ");
  return {
    kind: ok > 0 ? "info" : "error",
    text: `${verb} ${ok}. Skipped ${failed.length}: ${detail}`,
  };
}

export default function FilesManager({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const [note, flash] = useFlashNote();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [status, setStatus] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [nameInput, setNameInput] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const load = useCallback(async (target: string) => {
    try {
      const next = await listFolder(target);
      setListing(next);
      setPath(next.path);
      setSelected(new Set());
      setAnchor(null);
    } catch (e) {
      setStatus({ kind: "error", text: formatError(e) });
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const entries = listing?.entries ?? [];
  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const selectedPaths = Array.from(selected);
  const crumbs = path ? path.split("/") : [];

  const runTransfer = async (items: string[], dest: string, mode: "move" | "copy") => {
    setBusy(true);
    try {
      const results = await transferItems(items, dest, mode);
      setStatus(summarize(results, mode === "move" ? "Moved" : "Copied"));
      await load(path);
    } catch (e) {
      setStatus({ kind: "error", text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    setBusy(true);
    try {
      const results = await deleteItems(selectedPaths);
      setDialog(null);
      setStatus(summarize(results, "Deleted"));
      await load(path);
    } catch (e) {
      setStatus({ kind: "error", text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const runRename = async () => {
    const target = selectedEntries[0];
    if (!target || !nameInput.trim()) return;
    setBusy(true);
    try {
      await renameItem(target.path, nameInput.trim());
      setDialog(null);
      setStatus({ kind: "info", text: `Renamed to ${nameInput.trim()}.` });
      await load(path);
    } catch (e) {
      setStatus({ kind: "error", text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const runNewFolder = async () => {
    if (!nameInput.trim()) return;
    setBusy(true);
    try {
      await createFolder(path, nameInput.trim());
      setDialog(null);
      setStatus({ kind: "info", text: `Created ${nameInput.trim()}.` });
      await load(path);
    } catch (e) {
      setStatus({ kind: "error", text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const openDialog = (next: DialogState) => {
    setNameInput(next?.kind === "rename" ? (selectedEntries[0]?.name ?? "") : "");
    setDialog(next);
  };

  const onRowClick = (e: React.MouseEvent, index: number, entry: FileEntry) => {
    if (e.shiftKey && anchor !== null) {
      const [lo, hi] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(entries.slice(lo, hi + 1).map((x) => x.path)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchor(index);
      return;
    }
    setSelected(new Set([entry.path]));
    setAnchor(index);
  };

  const selectedMedia = selectedEntries.filter((e) => !e.is_dir && isMediaFile(e.name));

  const selectedFiles = selectedEntries.filter((e) => !e.is_dir);
  const selectedFolderCount = selectedEntries.length - selectedFiles.length;

  // One file per download, spaced out: browsers block a burst of automatic
  // downloads, and files are never zipped.
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
    const skipped = selectedFolderCount > 0 ? `, skipped ${selectedFolderCount} folder(s)` : "";
    flash(`Downloading ${selectedFiles.length} file(s)${skipped}`);
  };

  const addSelectedToPlaylist = () => {
    player.addTracks(selectedMedia.map((e) => fileTrack(e.path, e.name, mediaKindFromName(e.name))));
    flash(addedNote(selectedMedia.length));
  };

  const onRowDoubleClick = (entry: FileEntry) => {
    if (entry.is_dir) void load(entry.path);
    else openFileRow(player, entry.path, entry.name);
  };

  const toggleOne = (entry: FileEntry, index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    setAnchor(index);
  };

  const onDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const items = selected.has(entry.path) ? selectedPaths : [entry.path];
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(items));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const onDragOverFolder = (e: React.DragEvent, target: string) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? "copy" : "move";
    setDropTarget(target);
  };

  const onDropOnFolder = (e: React.DragEvent, target: string) => {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    setDropTarget(null);
    if (!raw) return;
    e.preventDefault();
    const items = JSON.parse(raw) as string[];
    void runTransfer(items, target, e.ctrlKey || e.altKey ? "copy" : "move");
  };

  const allSelected = entries.length > 0 && selected.size === entries.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(entries.map((x) => x.path)));

  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => onDragOverFolder(e, target),
    onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => onDropOnFolder(e, target),
  });

  return (
    <div className={styles.page} role="dialog" aria-label="File manager">
      <header className={styles.header}>
        <span className={styles.title}>Files</span>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close file manager">
          ×
        </button>
      </header>

      <div className={styles.toolbar}>
        <button
          className={styles.tool}
          onClick={() => listing?.parent != null && load(listing.parent)}
          disabled={!path || busy}
        >
          ↰ Up
        </button>
        <button className={styles.tool} onClick={() => openDialog({ kind: "newFolder" })} disabled={busy}>
          New folder
        </button>
        <button
          className={styles.tool}
          onClick={() => openDialog({ kind: "rename" })}
          disabled={busy || selected.size !== 1}
        >
          Rename
        </button>
        <button
          className={styles.tool}
          onClick={() => openDialog({ kind: "move" })}
          disabled={busy || selected.size === 0}
        >
          Move to…
        </button>
        <button
          className={styles.tool}
          onClick={() => openDialog({ kind: "copy" })}
          disabled={busy || selected.size === 0}
        >
          Copy to…
        </button>
        <button className={styles.tool} onClick={addSelectedToPlaylist} disabled={selectedMedia.length === 0}>
          + Playlist
        </button>
        <button className={styles.tool} onClick={downloadSelected} disabled={busy || selectedFiles.length === 0}>
          Download
        </button>
        <button
          className={`${styles.tool} ${styles.danger}`}
          onClick={() => openDialog({ kind: "delete" })}
          disabled={busy || selected.size === 0}
        >
          Delete
        </button>
        <button className={styles.tool} onClick={() => load(path)} disabled={busy}>
          Refresh
        </button>
      </div>

      <nav className={styles.crumbs} aria-label="Folder path">
        <button
          className={`${styles.crumb} ${dropTarget === "" ? styles.dropOn : ""}`}
          onClick={() => load("")}
          {...dropProps("")}
        >
          Library
        </button>
        {crumbs.map((part, i) => {
          const target = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={target} className={styles.crumbGroup}>
              <span className={styles.sep}>/</span>
              <button
                className={`${styles.crumb} ${dropTarget === target ? styles.dropOn : ""}`}
                onClick={() => load(target)}
                {...dropProps(target)}
              >
                {part}
              </button>
            </span>
          );
        })}
      </nav>

      {note && (
        <div className={styles.status} role="status">
          {note}
        </div>
      )}

      {status && (
        <div className={status.kind === "error" ? styles.statusError : styles.status} role="status">
          {status.text}
          <button className={styles.statusClose} onClick={() => setStatus(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colCheck}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>Name</th>
              <th className={styles.colSize}>Size</th>
              <th className={styles.colDate}>Modified</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const isSelected = selected.has(entry.path);
              const dropHere = entry.is_dir && dropTarget === entry.path;
              return (
                <tr
                  key={entry.path}
                  className={`${isSelected ? styles.rowSelected : ""} ${dropHere ? styles.dropOn : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, entry)}
                  onDragOver={entry.is_dir ? (e) => onDragOverFolder(e, entry.path) : undefined}
                  onDragLeave={entry.is_dir ? () => setDropTarget((t) => (t === entry.path ? null : t)) : undefined}
                  onDrop={entry.is_dir ? (e) => onDropOnFolder(e, entry.path) : undefined}
                  onClick={(e) => onRowClick(e, index, entry)}
                  onDoubleClick={() => onRowDoubleClick(entry)}
                >
                  <td className={styles.colCheck}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(entry, index)}
                      aria-label={`Select ${entry.name}`}
                    />
                  </td>
                  <td className={styles.name}>
                    <span className={styles.icon}>{entry.is_dir ? "📁" : "📄"}</span>
                    <span className={styles.nameText} title={entry.name}>{entry.name}</span>
                  </td>
                  <td className={styles.colSize}>{entry.is_dir ? "" : formatSize(entry.size)}</td>
                  <td className={styles.colDate}>{new Date(entry.modified * 1000).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {listing && entries.length === 0 && <div className={styles.empty}>This folder is empty.</div>}
        {!listing && <div className={styles.empty}>Loading…</div>}
      </div>

      <div className={styles.hint}>
        Click to select, Shift+click for a range, Ctrl+click to add one. Drag onto a folder to move
        (hold Ctrl or Alt to copy). Double-click a file to open it.
      </div>

      {dialog && (dialog.kind === "move" || dialog.kind === "copy") && (
        <Dialog
          title={`${dialog.kind === "move" ? "Move" : "Copy"} ${selectedPaths.length} item${selectedPaths.length === 1 ? "" : "s"} to…`}
          onClose={() => setDialog(null)}
        >
          <FolderBrowser
            initialPath={path}
            confirmLabel={dialog.kind === "move" ? "Move here" : "Copy here"}
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={(dest) => {
              setDialog(null);
              void runTransfer(selectedPaths, dest, dialog.kind);
            }}
          />
        </Dialog>
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
                if (e.key === "Enter") void (dialog.kind === "rename" ? runRename() : runNewFolder());
              }}
            />
            <div className={styles.dialogFoot}>
              <button className={styles.tool} onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className={styles.primary}
                onClick={() => void (dialog.kind === "rename" ? runRename() : runNewFolder())}
                disabled={busy || !nameInput.trim()}
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
              Delete {selectedEntries.length} item{selectedEntries.length === 1 ? "" : "s"} from disk:
            </p>
            <ul className={styles.deleteList}>
              {selectedEntries.map((e) => (
                <li key={e.path}>{e.is_dir ? `📁 ${e.name} (folder and everything in it)` : e.name}</li>
              ))}
            </ul>
            <p className={styles.warn}>This can't be undone. Library entries for deleted files are removed too.</p>
            <div className={styles.dialogFoot}>
              <button className={styles.tool} onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button className={`${styles.primary} ${styles.dangerPrimary}`} onClick={runDelete} disabled={busy}>
                Delete
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
