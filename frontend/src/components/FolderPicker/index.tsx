import { useEffect, useState } from "react";

import { createFolder, listFolder, type FolderListing } from "@/api/files";

import styles from "./FolderPicker.module.css";

const formatError = (e: unknown): string => {
  const raw = String(e).replace(/^ApiError: /, "");
  try {
    const body = JSON.parse(raw);
    if (body?.detail) return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {}
  return raw;
};

/** Modal shell shared by the folder picker and the file manager's dialogs. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogHead}>
          <span>{title}</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface BrowserProps {
  initialPath: string;
  /** Label of the confirm button, e.g. "Use this folder" or "Move here". */
  confirmLabel: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
  /** When set, a second button chooses the default folder (path ""). */
  defaultLabel?: string;
  onChooseDefault?: () => void;
  busy?: boolean;
  /** Extra line shown above the buttons, e.g. "Moving 3 items". */
  note?: string;
}

/** Folder tree browser. Lists folders only; lets the user create one in place. */
export function FolderBrowser({
  initialPath,
  confirmLabel,
  onConfirm,
  onCancel,
  defaultLabel,
  onChooseDefault,
  busy,
  note,
}: BrowserProps) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = async (path: string) => {
    try {
      setListing(await listFolder(path, true));
      setError(null);
    } catch (e) {
      setError(formatError(e));
      if (path !== "") void load("");
    }
  };

  useEffect(() => {
    void load(initialPath);
    // Browse starts from the path the caller passed in, once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = listing?.path ?? "";
  const crumbs = current ? current.split("/") : [];

  const makeFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await createFolder(current, name);
      setNewName("");
      await load(created.path);
    } catch (e) {
      setError(formatError(e));
    }
  };

  return (
    <div className={styles.browser}>
      <nav className={styles.crumbs} aria-label="Folder path">
        <button className={styles.crumb} onClick={() => load("")}>
          Library
        </button>
        {crumbs.map((part, i) => (
          <span key={`${part}-${i}`} className={styles.crumbGroup}>
            <span className={styles.sep}>/</span>
            <button
              className={styles.crumb}
              onClick={() => load(crumbs.slice(0, i + 1).join("/"))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>

      <div className={styles.list}>
        {listing?.parent != null && current !== "" && (
          <button className={styles.row} onClick={() => load(listing.parent ?? "")}>
            <span className={styles.folderIcon}>↰</span>
            <span>..</span>
          </button>
        )}
        {listing?.entries.map((e) => (
          <button key={e.path} className={styles.row} onClick={() => load(e.path)}>
            <span className={styles.folderIcon}>▸</span>
            <span className={styles.rowName}>{e.name}</span>
          </button>
        ))}
        {listing && listing.entries.length === 0 && (
          <div className={styles.empty}>No folders here yet.</div>
        )}
      </div>

      <div className={styles.newRow}>
        <input
          className={styles.input}
          placeholder="New folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void makeFolder()}
        />
        <button className={styles.secondaryBtn} onClick={makeFolder} disabled={!newName.trim()}>
          Create
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {note && <div className={styles.note}>{note}</div>}

      <div className={styles.footer}>
        <button className={styles.secondaryBtn} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {defaultLabel && onChooseDefault && (
          <button className={styles.secondaryBtn} onClick={onChooseDefault} disabled={busy}>
            {defaultLabel}
          </button>
        )}
        <button
          className={styles.primaryBtn}
          onClick={() => onConfirm(current)}
          disabled={busy || !listing}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

interface PickerProps {
  /** Root-relative folder. "" = the root, or the default when defaultLabel is set. */
  value: string;
  onChange: (path: string) => void;
  /** When set, "" means "the default folder" and the picker offers a button for it. */
  defaultLabel?: string;
  /** Visible label for the default choice, e.g. "Default folder". */
  label?: string;
}

/** A button that shows the chosen folder and opens the browser to change it. */
export default function FolderPicker({ value, onChange, defaultLabel, label }: PickerProps) {
  const [open, setOpen] = useState(false);
  const shown = value || (defaultLabel ? defaultLabel : "Library root");

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        title={label ?? "Choose folder"}
      >
        <span className={styles.folderIcon}>▸</span>
        <span className={styles.triggerText}>{shown}</span>
      </button>
      {open && (
        <Dialog title={label ?? "Choose folder"} onClose={() => setOpen(false)}>
          <FolderBrowser
            initialPath={value}
            confirmLabel="Use this folder"
            defaultLabel={defaultLabel ? defaultLabel : undefined}
            onChooseDefault={defaultLabel ? () => { onChange(""); setOpen(false); } : undefined}
            onConfirm={(path) => { onChange(path); setOpen(false); }}
            onCancel={() => setOpen(false)}
          />
        </Dialog>
      )}
    </>
  );
}
