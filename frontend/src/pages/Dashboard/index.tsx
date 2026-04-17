import { useEffect, useReducer, useState } from "react";

import Settings from "@/pages/Settings";
import { SkeletonRow } from "@/components/Skeleton";
import { createDownload, deleteDownload, downloadPlaylist, listDownloads, openDownload } from "@/api/downloads";
import { resolveMetadata } from "@/api/metadata";
import { getSettings, updateSettings } from "@/api/settings";
import {
  checkSubscription,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "@/api/subscriptions";
import {
  type DownloadCanceledPayload,
  type DownloadFailedPayload,
  type DownloadInfo,
  type DownloadUpdatedPayload,
  type SubscriptionCheckedPayload,
  type SubscriptionInfo,
  WS_EVENTS,
} from "@/ws/events";
import { getSocket } from "@/ws/socket";

import styles from "./Dashboard.module.css";

// ── Icons ─────────────────────────────────────────────────────────────────────

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const BellIcon = ({ muted = false }: { muted?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    {muted && <line x1="1" y1="1" x2="23" y2="23" />}
  </svg>
);

const FolderOpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <polyline points="9 14 12 11 15 14" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const GearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// ── Format spec builder ───────────────────────────────────────────────────────

function buildFormatSpec(
  type: string,
  quality: string,
  format: string,
  codec: string,
): string {
  if (type === "audio") {
    const ext = format !== "auto" ? format : "m4a";
    return `bestaudio[ext=${ext}]/bestaudio`;
  }

  const qualityFilter = quality !== "best" ? `[height<=${quality}]` : "";
  const formatFilter = format !== "auto" ? `[ext=${format}]` : "";
  const codecMap: Record<string, string> = {
    h264: "avc1",
    h265: "hevc",
    vp9: "vp9",
    av1: "av01",
  };
  const codecFilter =
    codec !== "auto" && codecMap[codec]
      ? `[vcodec^=${codecMap[codec]}]`
      : "";

  // Strict filters (codec/format) only on the merge path — they may not
  // exist as single-file progressive formats. Quality filter is safe everywhere.
  const strictFilters = `${qualityFilter}${formatFilter}${codecFilter}`;
  // Build: try strict merge → relaxed merge (quality only) → best single-file
  const parts: string[] = [];
  if (strictFilters) {
    parts.push(`bestvideo*${strictFilters}+bestaudio`);
  }
  parts.push(`bestvideo*${qualityFilter}+bestaudio`);
  parts.push(`best${qualityFilter}`);
  // Deduplicate (e.g. when no strict filters, first two are identical)
  const unique = [...new Set(parts)];
  return unique.join("/");
}

// ── Downloads reducer ─────────────────────────────────────────────────────────

type DownloadsAction =
  | { type: "SET"; downloads: DownloadInfo[] }
  | { type: "ADD"; download: DownloadInfo }
  | { type: "UPDATE"; patch: Partial<DownloadInfo> & { id: number } }
  | { type: "REMOVE"; id: number };

function downloadsReducer(
  state: DownloadInfo[],
  action: DownloadsAction,
): DownloadInfo[] {
  switch (action.type) {
    case "SET":
      return action.downloads;
    case "ADD":
      if (state.some((d) => d.id === action.download.id)) return state;
      return [action.download, ...state];
    case "UPDATE":
      return state.map((d) =>
        d.id === action.patch.id ? { ...d, ...action.patch } : d,
      );
    case "REMOVE":
      return state.filter((d) => d.id !== action.id);
  }
}

// ── Subscriptions reducer ─────────────────────────────────────────────────────

type SubsAction =
  | { type: "SET"; subs: SubscriptionInfo[] }
  | { type: "ADD"; sub: SubscriptionInfo }
  | { type: "UPDATE"; patch: Partial<SubscriptionInfo> & { id: number } }
  | { type: "REMOVE"; id: number };

function subsReducer(
  state: SubscriptionInfo[],
  action: SubsAction,
): SubscriptionInfo[] {
  switch (action.type) {
    case "SET":
      return action.subs;
    case "ADD":
      return [action.sub, ...state];
    case "UPDATE":
      return state.map((s) =>
        s.id === action.patch.id ? { ...s, ...action.patch } : s,
      );
    case "REMOVE":
      return state.filter((s) => s.id !== action.id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function qualityLabel(d: DownloadInfo): string {
  if (d.height) return `${d.height}p`;
  if (d.format_spec) return d.format_spec;
  return "\u2014";
}

function codecLabel(d: DownloadInfo): string {
  const parts = [];
  if (d.vcodec && d.vcodec !== "none") parts.push(d.vcodec.split(".")[0]);
  if (d.acodec && d.acodec !== "none") parts.push(d.acodec.split(".")[0]);
  if (parts.length) return parts.join(" / ");
  return d.ext ?? "\u2014";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  // ── URL / format state ────────────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [type, setType] = useState("video");
  const [quality, setQuality] = useState("best");
  const [format, setFormat] = useState("auto");
  const [codec, setCodec] = useState("auto");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Advanced options state ────────────────────────────────────────────────
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState("Default");
  const [subCheckInterval, setSubCheckInterval] = useState("60");
  const [optionPresets, setOptionPresets] = useState("");

  // ── Downloads state ───────────────────────────────────────────────────────
  const [downloads, dispatchDownloads] = useReducer(downloadsReducer, []);

  // ── Selection state ───────────────────────────────────────────────────────
  const [selectedActive, setSelectedActive] = useState<Set<number>>(new Set());
  const [selectedCompleted, setSelectedCompleted] = useState<Set<number>>(new Set());
  const [selectedSubs, setSelectedSubs] = useState<Set<number>>(new Set());

  // ── Sort state for completed ──────────────────────────────────────────────
  const [completedSortAsc, setCompletedSortAsc] = useState(false); // false = newest first

  // ── Subscriptions state ───────────────────────────────────────────────────
  const [subs, dispatchSubs] = useReducer(subsReducer, []);
  const [addSubOpen, setAddSubOpen] = useState(false);
  const [subUrl, setSubUrl] = useState("");
  const [subInterval, setSubInterval] = useState("60");
  const [subDownloadExisting, setSubDownloadExisting] = useState(false);
  const [subNotify, setSubNotify] = useState(true);
  const [subFormat, setSubFormat] = useState("best");
  const [subSubmitting, setSubSubmitting] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [checkingSubId, setCheckingSubId] = useState<number | null>(null);

  // ── Settings modal ────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Loading state ─────────────────────────────────────────────────────────
  const [loadingDownloads, setLoadingDownloads] = useState(true);
  const [loadingSubs, setLoadingSubs] = useState(true);

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  // ── Load initial data + settings ─────────────────────────────────────────
  useEffect(() => {
    listDownloads()
      .then((data) => dispatchDownloads({ type: "SET", downloads: data }))
      .catch(console.error)
      .finally(() => setLoadingDownloads(false));

    listSubscriptions()
      .then((data) => dispatchSubs({ type: "SET", subs: data }))
      .catch(console.error)
      .finally(() => setLoadingSubs(false));

    getSettings()
      .then(({ settings }) => {
        if (settings.subscription_check_interval_minutes)
          setSubCheckInterval(settings.subscription_check_interval_minutes);
        if (settings.download_folder)
          setDownloadFolder(settings.download_folder);
        if (settings.option_presets)
          setOptionPresets(settings.option_presets);
      })
      .catch(console.error);
  }, []);

  // ── WebSocket listeners ───────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    socket.on(WS_EVENTS.DOWNLOAD_ADDED, (data: DownloadInfo) => {
      dispatchDownloads({ type: "ADD", download: data });
    });
    socket.on(WS_EVENTS.DOWNLOAD_UPDATED, (data: DownloadUpdatedPayload) => {
      dispatchDownloads({ type: "UPDATE", patch: data });
    });
    socket.on(WS_EVENTS.DOWNLOAD_COMPLETED, (data: DownloadInfo) => {
      dispatchDownloads({ type: "UPDATE", patch: data });
    });
    socket.on(WS_EVENTS.DOWNLOAD_FAILED, (data: DownloadFailedPayload) => {
      dispatchDownloads({
        type: "UPDATE",
        patch: { id: data.id, status: "failed", error_message: data.error },
      });
    });
    socket.on(WS_EVENTS.DOWNLOAD_CANCELED, (data: DownloadCanceledPayload) => {
      dispatchDownloads({
        type: "UPDATE",
        patch: { id: data.id, status: "canceled" },
      });
    });
    socket.on(
      WS_EVENTS.SUBSCRIPTION_CHECKED,
      (data: SubscriptionCheckedPayload) => {
        dispatchSubs({
          type: "UPDATE",
          patch: { id: data.id, last_checked_at: data.last_checked_at },
        });
      },
    );

    return () => {
      socket.off(WS_EVENTS.DOWNLOAD_ADDED);
      socket.off(WS_EVENTS.DOWNLOAD_UPDATED);
      socket.off(WS_EVENTS.DOWNLOAD_COMPLETED);
      socket.off(WS_EVENTS.DOWNLOAD_FAILED);
      socket.off(WS_EVENTS.DOWNLOAD_CANCELED);
      socket.off(WS_EVENTS.SUBSCRIPTION_CHECKED);
    };
  }, []);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const activeDownloads = downloads.filter(
    (d) => d.status === "queued" || d.status === "downloading",
  );
  const completedDownloadsRaw = downloads.filter(
    (d) =>
      d.status === "completed" ||
      d.status === "failed" ||
      d.status === "canceled",
  );
  const completedDownloads = completedSortAsc
    ? [...completedDownloadsRaw].reverse()
    : completedDownloadsRaw;
  const failedDownloads = completedDownloads.filter((d) => d.status === "failed");
  const totalSpeed = activeDownloads
    .map((d) => {
      if (!d.speed) return 0;
      const match = d.speed.match(/^([\d.]+)/);
      return match ? parseFloat(match[1]) : 0;
    })
    .reduce((a, b) => a + b, 0);
  const speedUnit = activeDownloads.find((d) => d.speed)?.speed?.replace(
    /^[\d.]+\s*/,
    "",
  ) ?? "MB/s";

  // ── Selection helpers ─────────────────────────────────────────────────────
  const toggleSelection = (
    setter: React.Dispatch<React.SetStateAction<Set<number>>>,
    id: number,
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllSelection = (
    items: { id: number }[],
    set: Set<number>,
    setter: React.Dispatch<React.SetStateAction<Set<number>>>,
  ) => {
    if (set.size === items.length) {
      setter(new Set());
    } else {
      setter(new Set(items.map((i) => i.id)));
    }
  };

  // ── Handlers: download submission ─────────────────────────────────────────
  const handleDownload = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const formatSpec = buildFormatSpec(type, quality, format, codec);
      // Resolve metadata first to get title / thumbnail
      const meta = await resolveMetadata(trimmed);
      await createDownload({
        url: trimmed,
        format_spec: formatSpec,
        title: meta.title,
        thumbnail: meta.thumbnail ?? undefined,
        duration: meta.duration ?? undefined,
      });
      setUrl("");
    } catch (err) {
      let message = String(err);
      try {
        const body = JSON.parse(message.replace(/^ApiError: /, ""));
        if (body?.detail) message = body.detail;
      } catch {}

      // Playlist detected — download all videos via playlist endpoint
      if (message === "PLAYLIST_URL") {
        try {
          const formatSpec = buildFormatSpec(type, quality, format, codec);
          await downloadPlaylist(trimmed, formatSpec);
          setUrl("");
          return;
        } catch (playlistErr) {
          let plMsg = String(playlistErr);
          try {
            const body = JSON.parse(plMsg.replace(/^ApiError: /, ""));
            if (body?.detail) plMsg = body.detail;
          } catch {}
          setSubmitError(plMsg);
          return;
        }
      }

      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubscribe = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const sub = await createSubscription({
        url: trimmed,
        check_interval_minutes: parseInt(subCheckInterval) || 60,
        format_spec: buildFormatSpec(type, quality, format, codec),
        download_existing: false,
      });
      dispatchSubs({ type: "ADD", sub });
      setUrl("");
    } catch (err) {
      let message = String(err);
      try {
        const body = JSON.parse(message.replace(/^ApiError: /, ""));
        if (body?.detail) message = body.detail;
      } catch {}
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleDownload();
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteDownload(id);
      dispatchDownloads({ type: "REMOVE", id });
      setSelectedActive((prev) => { const n = new Set(prev); n.delete(id); return n; });
      setSelectedCompleted((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch (err) {
      console.error(err);
    }
  };

  // ── Handlers: bulk actions ────────────────────────────────────────────────
  const handleClearSelected = async (ids: Set<number>) => {
    for (const id of ids) {
      await handleDelete(id);
    }
  };

  const handleClearCompleted = async () => {
    const toDelete = completedDownloads.filter((d) => d.status === "completed");
    for (const d of toDelete) {
      await handleDelete(d.id);
    }
  };

  const handleClearFailed = async () => {
    for (const d of failedDownloads) {
      await handleDelete(d.id);
    }
  };

  const handleRetryFailed = async () => {
    const formatSpec = buildFormatSpec(type, quality, format, codec);
    for (const d of failedDownloads) {
      try {
        await handleDelete(d.id);
        await createDownload({
          url: d.url,
          format_spec: formatSpec,
          title: d.title ?? undefined,
        });
      } catch (e) {
        console.error("Retry failed for", d.url, e);
      }
    }
  };

  // ── Handlers: advanced options save ──────────────────────────────────────
  const handleSaveSettings = async () => {
    await updateSettings({
      subscription_check_interval_minutes: subCheckInterval,
      download_folder: downloadFolder,
      option_presets: optionPresets,
    }).catch(console.error);
  };

  // ── Handlers: import URLs ─────────────────────────────────────────────────
  const handleImport = async () => {
    const lines = importText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const formatSpec = buildFormatSpec(type, quality, format, codec);
    for (const line of lines) {
      try {
        const meta = await resolveMetadata(line);
        await createDownload({
          url: line,
          format_spec: formatSpec,
          title: meta.title,
        });
      } catch (e) {
        console.error("Import failed for", line, e);
      }
    }
    setImportText("");
    setImportOpen(false);
  };

  const handleCopyUrls = () => {
    const allUrls = downloads.map((d) => d.url).join("\n");
    navigator.clipboard.writeText(allUrls).catch(console.error);
  };

  const handleExportUrls = () => {
    window.open("/api/downloads/export", "_blank");
  };

  // ── Handlers: subscriptions ───────────────────────────────────────────────
  const handleAddSubscription = async () => {
    const trimmed = subUrl.trim();
    if (!trimmed) return;
    setSubSubmitting(true);
    setSubError(null);

    try {
      const sub = await createSubscription({
        url: trimmed,
        check_interval_minutes: parseInt(subInterval) || 60,
        format_spec: subFormat,
        download_existing: subDownloadExisting,
        notify: subNotify,
      });
      dispatchSubs({ type: "ADD", sub });
      setSubUrl("");
      setAddSubOpen(false);
    } catch (err) {
      let message = String(err);
      try {
        const body = JSON.parse(message.replace(/^ApiError: /, ""));
        if (body?.detail) message = body.detail;
      } catch {}
      setSubError(message);
    } finally {
      setSubSubmitting(false);
    }
  };

  const handleToggleSub = async (sub: SubscriptionInfo) => {
    try {
      const updated = await updateSubscription(sub.id, {
        is_active: !sub.is_active,
      });
      dispatchSubs({ type: "UPDATE", patch: updated });
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleSubNotify = async (sub: SubscriptionInfo) => {
    try {
      const updated = await updateSubscription(sub.id, {
        notify: !sub.notify,
      });
      dispatchSubs({ type: "UPDATE", patch: updated });
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteSub = async (id: number) => {
    try {
      await deleteSubscription(id);
      dispatchSubs({ type: "REMOVE", id });
      setSelectedSubs((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteSelectedSubs = async () => {
    for (const id of selectedSubs) {
      await handleDeleteSub(id);
    }
    setSelectedSubs(new Set());
  };

  const handleCheckSub = async (id: number) => {
    setCheckingSubId(id);
    try {
      await checkSubscription(id);
    } catch (err) {
      console.error(err);
    } finally {
      setCheckingSubId(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.app}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <span className={styles.brand}>MeTube<span className={styles.brandPlus}>Plus</span></span>
        <div className={styles.headerStats}>
          {activeDownloads.length > 0 && (
            <>
              <span className={styles.statBadge}>
                {activeDownloads.length} downloading
              </span>
              {totalSpeed > 0 && (
                <span className={styles.statSpeed}>
                  {totalSpeed.toFixed(2)} {speedUnit}
                </span>
              )}
            </>
          )}
        </div>
        <button className={styles.settingsBtn} onClick={() => setSettingsOpen(true)} title="Settings">
          <GearIcon />
        </button>
      </header>

      {/* ── Main content ── */}
      <main className={styles.main}>
        {/* ── URL input row ── */}
        <div className={styles.inputSection}>
          <div className={styles.inputRow}>
            <input
              className={styles.urlInput}
              type="url"
              placeholder="Enter video, channel, or playlist URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleUrlKeyDown}
              aria-label="Video URL"
            />
            <button
              className={styles.downloadBtn}
              onClick={handleDownload}
              disabled={isSubmitting || !url.trim()}
            >
              {isSubmitting ? "Adding\u2026" : "Download"}
            </button>
            <button
              className={styles.subscribeBtn}
              onClick={handleSubscribe}
              disabled={isSubmitting || !url.trim()}
            >
              Subscribe
            </button>
          </div>

          {/* ── Format dropdowns ── */}
          <div className={styles.formatRow}>
            <label className={styles.dropdownLabel}>
              Type
              <select
                className={styles.dropdown}
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
            </label>
            <label className={styles.dropdownLabel}>
              Codec
              <select
                className={styles.dropdown}
                value={codec}
                onChange={(e) => setCodec(e.target.value)}
              >
                <option value="auto">Auto</option>
                <option value="h264">H.264</option>
                <option value="h265">H.265</option>
                <option value="vp9">VP9</option>
                <option value="av1">AV1</option>
              </select>
            </label>
            <label className={styles.dropdownLabel}>
              Format
              <select
                className={styles.dropdown}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="auto">Auto</option>
                <option value="mp4">mp4</option>
                <option value="webm">webm</option>
                <option value="mkv">mkv</option>
                {type === "audio" && <option value="m4a">m4a</option>}
                {type === "audio" && <option value="mp3">mp3</option>}
              </select>
            </label>
            <label className={styles.dropdownLabel}>
              Quality
              <select
                className={styles.dropdown}
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                <option value="best">Best</option>
                {type === "video" && <option value="2160">4K</option>}
                {type === "video" && <option value="1440">1440p</option>}
                {type === "video" && <option value="1080">1080p</option>}
                {type === "video" && <option value="720">720p</option>}
                {type === "video" && <option value="480">480p</option>}
                {type === "video" && <option value="360">360p</option>}
              </select>
            </label>
          </div>

          {submitError && (
            <p className={styles.errorMsg}>{submitError}</p>
          )}
        </div>

        {/* ── Advanced Options accordion ── */}
        <div className={styles.advancedSection}>
          <button
            className={styles.advancedToggle}
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            <span className={styles.advancedToggleIcon}>
              {advancedOpen ? "\u25BE" : "\u25B8"}
            </span>
            Advanced Options
          </button>

          {advancedOpen && (
            <div className={styles.advancedPanel}>
              {/* OUTPUT */}
              <div className={styles.advancedGroup}>
                <p className={styles.advancedGroupTitle}>OUTPUT</p>
                <div className={styles.advancedRow}>
                  <label className={styles.advancedLabel}>
                    Download Folder
                    <input
                      className={styles.advancedInput}
                      value={downloadFolder}
                      onChange={(e) => setDownloadFolder(e.target.value)}
                      onBlur={handleSaveSettings}
                    />
                  </label>
                  <label className={styles.advancedLabel}>
                    Custom Name Profile
                    <select className={styles.advancedSelect}>
                      <option>Default</option>
                    </select>
                  </label>
                  <label className={styles.advancedCheckbox}>
                    <input type="checkbox" disabled />
                    Split by chapters
                  </label>
                </div>
              </div>

              {/* BEHAVIOR */}
              <div className={styles.advancedGroup}>
                <p className={styles.advancedGroupTitle}>BEHAVIOR</p>
                <div className={styles.advancedRow}>
                  <label className={styles.advancedLabel}>
                    Auto Start
                    <select className={styles.advancedSelect} defaultValue="yes">
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                  <label className={styles.advancedLabel}>
                    Items Limit
                    <input
                      className={styles.advancedInput}
                      placeholder="Default"
                      type="number"
                      min="1"
                    />
                  </label>
                  <label className={styles.advancedLabel}>
                    Subscription Check (min)
                    <input
                      className={styles.advancedInput}
                      type="number"
                      min="1"
                      value={subCheckInterval}
                      onChange={(e) => setSubCheckInterval(e.target.value)}
                      onBlur={handleSaveSettings}
                    />
                  </label>
                </div>
              </div>

              {/* YT-DLP */}
              <div className={styles.advancedGroup}>
                <p className={styles.advancedGroupTitle}>YT-DLP</p>
                <div className={styles.advancedRow}>
                  <label className={`${styles.advancedLabel} ${styles.advancedLabelFull}`}>
                    Option Presets
                    <input
                      className={styles.advancedInput}
                      placeholder="e.g. --no-playlist --write-subs"
                      value={optionPresets}
                      onChange={(e) => setOptionPresets(e.target.value)}
                      onBlur={handleSaveSettings}
                    />
                  </label>
                </div>
              </div>

              {/* TOOLS */}
              <div className={styles.advancedGroup}>
                <p className={styles.advancedGroupTitle}>TOOLS</p>
                <div className={styles.advancedRow}>
                  <div className={styles.toolsCol}>
                    <p className={styles.toolsSubTitle}>Cookies</p>
                    <button className={styles.toolBtn}>Upload Cookies</button>
                  </div>
                  <div className={styles.toolsCol}>
                    <p className={styles.toolsSubTitle}>Bulk Actions</p>
                    <div className={styles.bulkActions}>
                      <button
                        className={styles.toolBtn}
                        onClick={() => setImportOpen((o) => !o)}
                      >
                        Import URLs
                      </button>
                      <button className={styles.toolBtn} onClick={handleExportUrls}>
                        Export URLs
                      </button>
                      <button className={styles.toolBtn} onClick={handleCopyUrls}>
                        Copy URLs
                      </button>
                    </div>
                  </div>
                </div>
                {importOpen && (
                  <div className={styles.importBox}>
                    <textarea
                      className={styles.importTextarea}
                      rows={5}
                      placeholder="One URL per line"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                    />
                    <div className={styles.importActions}>
                      <button className={styles.importBtn} onClick={handleImport}>
                        Import
                      </button>
                      <button
                        className={styles.cancelBtn}
                        onClick={() => setImportOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Downloading section ── */}
        <section className={styles.tableSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Downloading</h2>
            <div className={styles.sectionActions}>
              <button
                className={styles.ghostBtn}
                disabled={selectedActive.size === 0}
                onClick={() => handleClearSelected(selectedActive)}
              >
                Clear selected
              </button>
              <button className={styles.ghostBtn} disabled>
                Download Paused
              </button>
            </div>
          </div>

          {loadingDownloads ? (
            <table className={styles.table}>
              <tbody>
                <SkeletonRow />
                <SkeletonRow />
              </tbody>
            </table>
          ) : activeDownloads.length === 0 ? (
            <div className={styles.emptyState}>
              <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <p className={styles.emptyTitle}>No active downloads</p>
              <p className={styles.emptyHint}>Paste a URL above and click Download to get started.</p>
            </div>
          ) : (
            <table className={styles.table}>
              <colgroup>
                <col style={{ width: "36px" }} />
                <col style={{ width: "100%" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "40px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={activeDownloads.length > 0 && selectedActive.size === activeDownloads.length}
                      onChange={() => toggleAllSelection(activeDownloads, selectedActive, setSelectedActive)}
                    />
                  </th>
                  <th>Video</th>
                  <th>Type</th>
                  <th>Quality</th>
                  <th>Speed</th>
                  <th>ETA</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {activeDownloads.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={selectedActive.has(d.id)}
                        onChange={() => toggleSelection(setSelectedActive, d.id)}
                      />
                    </td>
                    <td>
                      <div className={styles.videoCell}>
                        {d.thumbnail && (
                          <img className={styles.thumb} src={d.thumbnail} alt="" loading="lazy" />
                        )}
                        <div className={styles.videoCellText}>
                          <span className={styles.videoTitle} title={d.title ?? d.url}>
                            {d.title ?? d.url}
                          </span>
                          <div className={styles.progressTrack}>
                            <div
                              className={styles.progressFill}
                              style={{ width: `${d.percent}%` }}
                            />
                          </div>
                          <span className={styles.percentLabel}>
                            {d.percent.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className={styles.metaCell}>
                      {d.vcodec === "none" ? "Audio" : "Video"}
                    </td>
                    <td className={styles.metaCell}>{qualityLabel(d)}</td>
                    <td className={styles.metaCell}>{d.speed ?? "\u2014"}</td>
                    <td className={styles.metaCell}>
                      {d.eta != null ? `${d.eta}s` : "\u2014"}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          className={styles.iconBtn}
                          onClick={() => handleDelete(d.id)}
                          title="Cancel / Remove"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Completed section ── */}
        <section className={styles.tableSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Completed</h2>
          </div>
          <div className={styles.completedToolbar}>
            <button
              className={styles.sortBtn}
              onClick={() => setCompletedSortAsc((v) => !v)}
            >
              <span className={styles.sortIcon}>{completedSortAsc ? "\u2191" : "\u2193"}</span>
              {completedSortAsc ? "Oldest first" : "Newest first"}
            </button>
            <div className={styles.toolbarDivider} />
            <button
              className={styles.ghostBtn}
              disabled={selectedCompleted.size === 0}
              onClick={() => handleClearSelected(selectedCompleted)}
            >
              Clear selected
            </button>
            <button
              className={styles.ghostBtn}
              disabled={completedDownloads.filter((d) => d.status === "completed").length === 0}
              onClick={handleClearCompleted}
            >
              Clear completed
            </button>
            <button
              className={styles.ghostBtn}
              disabled={failedDownloads.length === 0}
              onClick={handleClearFailed}
            >
              Clear failed
            </button>
            <button
              className={styles.ghostBtn}
              disabled={failedDownloads.length === 0}
              onClick={handleRetryFailed}
            >
              Retry failed
            </button>
          </div>
          {selectedCompleted.size > 0 && (
            <div className={styles.downloadSelectedBar}>
              Download Selected
            </div>
          )}

          {completedDownloads.length === 0 && !loadingDownloads ? (
            <div className={styles.emptyState}>
              <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              <p className={styles.emptyTitle}>No completed downloads</p>
              <p className={styles.emptyHint}>Finished downloads will appear here.</p>
            </div>
          ) : (
            <table className={styles.table}>
              <colgroup>
                <col style={{ width: "36px" }} />
                <col style={{ width: "40%" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "150px" }} />
                <col style={{ width: "160px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={completedDownloads.length > 0 && selectedCompleted.size === completedDownloads.length}
                      onChange={() => toggleAllSelection(completedDownloads, selectedCompleted, setSelectedCompleted)}
                    />
                  </th>
                  <th>Video</th>
                  <th>Type</th>
                  <th>Quality</th>
                  <th>Codec / Format</th>
                  <th>File Size</th>
                  <th>Downloaded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {completedDownloads.map((d) => (
                  <tr
                    key={d.id}
                    className={d.status === "failed" ? styles.rowFailed : ""}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={selectedCompleted.has(d.id)}
                        onChange={() => toggleSelection(setSelectedCompleted, d.id)}
                      />
                    </td>
                    <td>
                      <div className={styles.videoCell}>
                        {d.thumbnail && (
                          <img className={styles.thumb} src={d.thumbnail} alt="" loading="lazy" />
                        )}
                        <div className={styles.videoCellText}>
                          <span className={styles.videoTitle} title={d.title ?? d.url}>
                            {d.title ?? d.url}
                          </span>
                          {d.status === "failed" && d.error_message && (
                            <span className={styles.errorInline}>{d.error_message}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={styles.metaCell}>
                      {d.vcodec === "none" ? "Audio" : "Video"}
                    </td>
                    <td className={styles.metaCell}>{qualityLabel(d)}</td>
                    <td className={styles.metaCell}>{codecLabel(d)}</td>
                    <td className={styles.metaCell}>{formatBytes(d.filesize)}</td>
                    <td className={styles.metaCell}>{formatDate(d.updated_at)}</td>
                    <td>
                      <div className={styles.rowActions}>
                        {d.status === "completed" && d.output_path && (
                          <>
                            <button
                              className={styles.iconBtn}
                              onClick={() =>
                                window.open(`/api/downloads/${d.id}/stream`, "_blank")
                              }
                              title="Play in new tab"
                            >
                              <PlayIcon />
                            </button>
                            <button
                              className={styles.iconBtn}
                              onClick={() => openDownload(d.id).catch(console.error)}
                              title="Open file in Explorer"
                            >
                              <FolderOpenIcon />
                            </button>
                          </>
                        )}
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          onClick={() => handleDelete(d.id)}
                          title="Remove"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Subscriptions section ── */}
        <section className={styles.tableSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Subscriptions</h2>
            <div className={styles.sectionActions}>
              <button
                className={styles.accentBtn}
                onClick={() => setAddSubOpen((o) => !o)}
              >
                {addSubOpen ? "Cancel" : "Add subscription"}
              </button>
              <button
                className={styles.ghostBtn}
                disabled={selectedSubs.size === 0}
                onClick={handleDeleteSelectedSubs}
              >
                Delete selected
              </button>
            </div>
          </div>

          {/* Add subscription form */}
          {addSubOpen && (
            <div className={styles.addSubForm}>
              <div className={styles.addSubRow}>
                <input
                  className={styles.urlInput}
                  type="url"
                  placeholder="Playlist or channel URL"
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                />
                <label className={styles.dropdownLabel}>
                  Interval (min)
                  <input
                    className={styles.advancedInput}
                    type="number"
                    min="1"
                    value={subInterval}
                    onChange={(e) => setSubInterval(e.target.value)}
                    style={{ width: "80px" }}
                  />
                </label>
                <label className={styles.dropdownLabel}>
                  Format
                  <input
                    className={styles.advancedInput}
                    value={subFormat}
                    onChange={(e) => setSubFormat(e.target.value)}
                    style={{ width: "100px" }}
                  />
                </label>
              </div>
              <div className={styles.addSubRow}>
                <label className={styles.advancedCheckbox}>
                  <input
                    type="checkbox"
                    checked={subDownloadExisting}
                    onChange={(e) => setSubDownloadExisting(e.target.checked)}
                  />
                  Download videos already in the playlist
                </label>
                <label className={styles.advancedCheckbox}>
                  <input
                    type="checkbox"
                    checked={subNotify}
                    onChange={(e) => setSubNotify(e.target.checked)}
                  />
                  Get notifications for this subscription
                </label>
                <button
                  className={styles.downloadBtn}
                  onClick={handleAddSubscription}
                  disabled={subSubmitting || !subUrl.trim()}
                >
                  {subSubmitting ? "Subscribing\u2026" : "Subscribe"}
                </button>
              </div>
              {subError && <p className={styles.errorMsg}>{subError}</p>}
            </div>
          )}

          {loadingSubs ? (
            <table className={styles.table}>
              <tbody>
                <SkeletonRow />
                <SkeletonRow />
              </tbody>
            </table>
          ) : subs.length === 0 && !addSubOpen ? (
            <div className={styles.emptyState}>
              <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0 1 18 14.158V11a6 6 0 0 0-4-5.659V5a2 2 0 1 0-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
              </svg>
              <p className={styles.emptyTitle}>No subscriptions</p>
              <p className={styles.emptyHint}>Subscribe to a playlist or channel to auto-download new videos.</p>
            </div>
          ) : (
            <table className={styles.table}>
              <colgroup>
                <col style={{ width: "36px" }} />
                <col style={{ width: "28%" }} />
                <col style={{ width: "28%" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "150px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "200px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={subs.length > 0 && selectedSubs.size === subs.length}
                      onChange={() => toggleAllSelection(subs, selectedSubs, setSelectedSubs)}
                    />
                  </th>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Interval (min)</th>
                  <th>Last checked</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={selectedSubs.has(s.id)}
                        onChange={() => toggleSelection(setSelectedSubs, s.id)}
                      />
                    </td>
                    <td>
                      <div className={styles.videoCell}>
                        <div className={styles.subThumb}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.87v6.26a1 1 0 0 1-1.447.9L15 14M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z"/>
                          </svg>
                        </div>
                        <span className={styles.videoTitle} title={s.title ?? s.url}>
                          {s.title ?? s.url}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`${styles.metaCell} ${styles.urlTruncate}`}
                        title={s.url}
                      >
                        {s.url}
                      </span>
                    </td>
                    <td className={styles.metaCell}>{s.check_interval_minutes}</td>
                    <td className={styles.metaCell}>
                      {formatDate(s.last_checked_at)}
                    </td>
                    <td>
                      <button
                        className={s.is_active ? styles.statusActive : styles.statusInactive}
                        onClick={() => handleToggleSub(s)}
                        title={s.is_active ? "Click to pause" : "Click to resume"}
                      >
                        {s.is_active ? "Active" : "Paused"}
                      </button>
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          className={styles.iconBtn}
                          onClick={() => handleCheckSub(s.id)}
                          disabled={checkingSubId === s.id}
                          title={checkingSubId === s.id ? "Checking…" : "Check now"}
                        >
                          <RefreshIcon />
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={() => handleToggleSubNotify(s)}
                          title={s.notify ? "Notifications on — click to mute" : "Notifications muted — click to enable"}
                          style={{ opacity: s.notify ? 1 : 0.5 }}
                        >
                          <BellIcon muted={!s.notify} />
                        </button>
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          onClick={() => handleDeleteSub(s.id)}
                          title="Delete subscription"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      {/* ── Settings modal ── */}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
