import type { MediaEntry } from "@/api/media";

import type { Mods } from "./shared";
import Tile from "./Tile";
import styles from "./MediaManager.module.css";

interface Props {
  title: string;
  /** The folder this group shows; null for the loose-files group of the current folder. */
  folder: MediaEntry | null;
  /** Number of entries the folder holds, or null while not loaded. */
  count: number | null;
  collapsed: boolean;
  files: MediaEntry[];
  subfolders: MediaEntry[];
  selected: Set<string>;
  isPlayable: (e: MediaEntry) => boolean;
  onToggleCollapse: () => void;
  onToggleSelect: (e: MediaEntry) => void;
  onTileClick: (ev: Mods, e: MediaEntry) => void;
  onAddOne: (e: MediaEntry) => void;
  onOpenFolder: (e: MediaEntry) => void;
  onPlayFolder: (f: MediaEntry) => void;
  onAddFolder: (f: MediaEntry) => void;
  onRenameFolder: (f: MediaEntry) => void;
  onMoveFolder: (f: MediaEntry) => void;
}

export default function Group(p: Props) {
  const { folder } = p;
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        {folder && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={p.selected.has(folder.path)}
              onChange={() => p.onToggleSelect(folder)}
              aria-label={`Select folder ${folder.name}`}
            />
          </label>
        )}
        <button
          className={styles.collapseBtn}
          onClick={p.onToggleCollapse}
          aria-expanded={!p.collapsed}
          aria-label={p.collapsed ? `Expand ${p.title}` : `Collapse ${p.title}`}
        >
          {p.collapsed ? "▸" : "▾"}
        </button>
        {folder ? (
          <button className={styles.groupName} onClick={() => p.onOpenFolder(folder)} title={`Open ${folder.name}`}>
            {p.title}
          </button>
        ) : (
          <span className={styles.groupNamePlain}>{p.title}</span>
        )}
        {p.count !== null && <span className={styles.badge}>{p.count}</span>}
        <span className={styles.spacer} />
        {folder && (
          <>
            <button className={styles.btn} onClick={() => p.onPlayFolder(folder)}>▶ Play folder</button>
            <button className={styles.btn} onClick={() => p.onAddFolder(folder)}>+ Add folder</button>
            <button className={styles.btn} onClick={() => p.onRenameFolder(folder)}>Rename</button>
            <button className={styles.btn} onClick={() => p.onMoveFolder(folder)}>Move…</button>
          </>
        )}
      </div>
      {!p.collapsed && (
        <div className={styles.groupBody}>
          {p.subfolders.length > 0 && (
            <div className={styles.subfolders}>
              {p.subfolders.map((f) => (
                <button key={f.path} className={styles.btn} onClick={() => p.onOpenFolder(f)}>📁 {f.name}</button>
              ))}
            </div>
          )}
          {p.files.length > 0 ? (
            <div className={styles.grid}>
              {p.files.map((f) => (
                <Tile
                  key={f.path}
                  entry={f}
                  selected={p.selected.has(f.path)}
                  playable={p.isPlayable(f)}
                  onClick={(ev) => p.onTileClick(ev, f)}
                  onToggle={() => p.onToggleSelect(f)}
                  onAdd={() => p.onAddOne(f)}
                />
              ))}
            </div>
          ) : (
            p.subfolders.length === 0 && <div className={styles.hint}>No files to show here.</div>
          )}
        </div>
      )}
    </section>
  );
}
