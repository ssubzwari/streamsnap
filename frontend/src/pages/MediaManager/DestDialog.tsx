import { useEffect, useState } from "react";

import { Dialog } from "@/components/FolderPicker";
import { errorText, listMedia, type MediaEntry, type MediaRoot } from "@/api/media";

import styles from "./MediaManager.module.css";

interface Props {
  title: string;
  confirmLabel: string;
  roots: MediaRoot[];
  initialRoot: string;
  initialPath: string;
  busy: boolean;
  onConfirm: (root: string, path: string) => void;
  onCancel: () => void;
}

/** Pick a destination folder in any available media root (the shared FolderBrowser only knows Downloads). */
export default function DestDialog({ title, confirmLabel, roots, initialRoot, initialPath, busy, onConfirm, onCancel }: Props) {
  const [root, setRoot] = useState(initialRoot);
  const [path, setPath] = useState(initialPath);
  const [folders, setFolders] = useState<MediaEntry[] | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFolders(null);
    listMedia(root, path)
      .then((l) => {
        if (!live) return;
        setFolders(l.entries.filter((e) => e.is_dir));
        setParent(l.parent);
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setError(errorText(e));
        setFolders([]);
      });
    return () => {
      live = false;
    };
  }, [root, path]);

  const crumbs = path ? path.split("/") : [];
  const rootLabel = roots.find((r) => r.id === root)?.label ?? "Root";

  return (
    <Dialog title={title} onClose={onCancel}>
      <div className={styles.destBody}>
        <label className={styles.destRoot}>
          <span>Folder set</span>
          <select
            className={styles.select}
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              setPath("");
            }}
          >
            {roots.filter((r) => r.available).map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </label>
        <nav className={styles.destCrumbs} aria-label="Destination path">
          <button className={styles.linkBtn} onClick={() => setPath("")}>{rootLabel}</button>
          {crumbs.map((part, i) => (
            <span key={`${part}-${i}`}>
              {" / "}
              <button className={styles.linkBtn} onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </nav>
        <div className={styles.destList}>
          {parent !== null && path !== "" && (
            <button className={styles.destRow} onClick={() => setPath(parent)}>↰ ..</button>
          )}
          {folders?.map((f) => (
            <button key={f.path} className={styles.destRow} onClick={() => setPath(f.path)}>📁 {f.name}</button>
          ))}
          {folders === null && <div className={styles.hint}>Loading…</div>}
          {folders !== null && folders.length === 0 && !error && <div className={styles.hint}>No folders here.</div>}
        </div>
        {error && <div className={styles.errorText}>{error}</div>}
        <div className={styles.dialogFoot}>
          <button className={styles.btn} onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`${styles.btn} ${styles.primary}`} onClick={() => onConfirm(root, path)} disabled={busy || folders === null || !!error}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
