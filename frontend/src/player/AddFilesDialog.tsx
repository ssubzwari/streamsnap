import { useEffect, useState } from "react";

import { listDownloads } from "@/api/downloads";
import { listFolder, type FolderListing } from "@/api/files";
import { Dialog } from "@/components/FolderPicker";
import type { DownloadInfo } from "@/ws/events";

import { fileTrack, isMediaFile, mediaKindFromName, streamTrack, usePlayer, withView, type Track } from "./PlayerContext";
import styles from "./Player.module.css";

type Tab = "library" | "folders";

/** One addable file; video rows get explicit "▶ Video" / "♫ Music" buttons next to the plain add. */
function MediaRow({ track, onAdd }: { track: Track; onAdd: (track: Track) => void }) {
  const main = (
    <button className={styles.addRow} onClick={() => onAdd(track)}>
      <span aria-hidden>{track.kind === "video" ? "🎬" : "🎵"}</span>
      <span className={styles.addRowName}>{track.title}</span>
    </button>
  );
  if (track.kind !== "video") return main;
  return (
    <div className={styles.addRowGroup}>
      {main}
      <button className={styles.addChoiceBtn} onClick={() => onAdd(withView(track, "video"))} title="Play in the video window">
        ▶ Video
      </button>
      <button className={styles.addChoiceBtn} onClick={() => onAdd(withView(track, "amp"))} title="Play the audio in the AMP">
        ♫ Music
      </button>
    </div>
  );
}

function LibraryTab({ onAdded }: { onAdded: (text: string) => void }) {
  const { addTracks } = usePlayer();
  const [rows, setRows] = useState<DownloadInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDownloads()
      .then((all) => setRows(all.filter((d) => d.status === "completed" && d.output_path)))
      .catch((e) => setError(String(e)));
  }, []);

  const q = query.trim().toLowerCase();
  const shown = rows.filter((d) => (d.title ?? d.url).toLowerCase().includes(q));

  return (
    <>
      <div className={styles.addToolbar}>
        <input
          className={styles.addInput}
          placeholder="Search library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={styles.addBtn}
          disabled={shown.length === 0}
          onClick={() => {
            addTracks(shown.map(streamTrack));
            onAdded(`Added ${shown.length} item${shown.length === 1 ? "" : "s"}`);
          }}
        >
          Add all shown
        </button>
      </div>
      <div className={styles.addList}>
        {shown.map((d) => (
          <MediaRow
            key={d.id}
            track={streamTrack(d)}
            onAdd={(t) => {
              addTracks([t]);
              onAdded(`Added: ${t.title}`);
            }}
          />
        ))}
        {shown.length === 0 && <div className={styles.addEmpty}>{error ?? "No matching downloads."}</div>}
      </div>
    </>
  );
}

function FoldersTab({ onAdded }: { onAdded: (text: string) => void }) {
  const { addTracks } = usePlayer();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (path: string) => {
    listFolder(path)
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    load("");
    // Start at the library root, once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = listing?.path ?? "";
  const crumbs = current ? current.split("/") : [];
  const entries = listing?.entries.filter((e) => e.is_dir || isMediaFile(e.name)) ?? [];

  return (
    <>
      <nav className={styles.addCrumbs} aria-label="Folder path">
        <button className={styles.linkBtn} onClick={() => load("")}>
          Library
        </button>
        {crumbs.map((part, i) => (
          <span key={`${part}-${i}`}>
            {" / "}
            <button className={styles.linkBtn} onClick={() => load(crumbs.slice(0, i + 1).join("/"))}>
              {part}
            </button>
          </span>
        ))}
      </nav>
      <div className={styles.addList}>
        {listing?.parent != null && current !== "" && (
          <button className={styles.addRow} onClick={() => load(listing.parent ?? "")}>
            <span aria-hidden>↰</span>
            <span className={styles.addRowName}>..</span>
          </button>
        )}
        {entries.map((e) =>
          e.is_dir ? (
            <button key={e.path} className={styles.addRow} onClick={() => load(e.path)}>
              <span aria-hidden>▸</span>
              <span className={styles.addRowName}>{e.name}</span>
            </button>
          ) : (
            <MediaRow
              key={e.path}
              track={fileTrack(e.path, e.name, mediaKindFromName(e.name))}
              onAdd={(t) => {
                addTracks([t]);
                onAdded(`Added: ${t.title}`);
              }}
            />
          ),
        )}
        {listing && entries.length === 0 && <div className={styles.addEmpty}>No folders or media here.</div>}
        {error && <div className={styles.addEmpty}>{error}</div>}
      </div>
    </>
  );
}

/** Dialog for appending library items or files from disk to the player queue. */
export default function AddFilesDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("library");
  const [added, setAdded] = useState<string | null>(null);

  return (
    <Dialog title="Add files" onClose={onClose}>
      <div className={styles.addBody}>
        <div className={styles.addTabs}>
          {(["library", "folders"] as const).map((t) => (
            <button
              key={t}
              className={`${styles.addTab} ${tab === t ? styles.addTabActive : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "library" ? "Library" : "Folders"}
            </button>
          ))}
        </div>
        {tab === "library" ? <LibraryTab onAdded={setAdded} /> : <FoldersTab onAdded={setAdded} />}
        <div className={styles.addStatus} aria-live="polite">
          {added}
        </div>
      </div>
    </Dialog>
  );
}
