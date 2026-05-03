import { useEffect, useReducer, useState } from "react";

import Settings from "@/pages/Settings";
import { SkeletonRow } from "@/components/Skeleton";
import CategoryPicker, { type CategoryPickerValue } from "@/components/CategoryPicker";
import {
  createDownload,
  deleteDownload,
  downloadFileUrl,
  downloadPlaylist,
  listCategories,
  listDownloads,
  type CategoryTree,
} from "@/api/downloads";
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
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const BellIcon = ({ muted = false }: { muted?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    {muted && <line x1="1" y1="1" x2="23" y2="23" />}
  </svg>
);

const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: open ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform var(--dur-fast) var(--ease-out)",
    }}
  >
    <polyline points="9 6 15 12 9 18" />
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

// ── Component ─────────────────────────────────────────────────────────────────

interface DashboardProps {
  settingsOpen: boolean;
  onCloseSettings: () => void;
  activeDownloadCount?: (count: number) => void;
  totalSpeedReport?: (speed: number, unit: string) => void;
}

export default function Dashboard({ settingsOpen, onCloseSettings, activeDownloadCount, totalSpeedReport }: DashboardProps) {
  // ── URL / format state ────────────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [type, setType] = useState("video");
  const [quality, setQuality] = useState("best");
  const [format, setFormat] = useState("auto");
  const [codec, setCodec] = useState("auto");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Category state (shared by Download + Subscribe in this row) ──────────
  const [categoryValue, setCategoryValue] = useState<CategoryPickerValue>({
    category: "",
    subcategory: "",
    tag: "",
  });
  const [categoryTree, setCategoryTree] = useState<CategoryTree | null>(null);

  // ── Toast / status banner ────────────────────────────────────────────────
  const [statusToast, setStatusToast] = useState<string | null>(null);

  // ── Collapsible section state ────────────────────────────────────────────
  // Persisted to localStorage so the layout sticks across reloads.
  const [openSections, setOpenSections] = useState<{
    downloading: boolean;
    completed: boolean;
    subscriptions: boolean;
  }>(() => {
    try {
      const raw = localStorage.getItem("metubeplus.openSections");
      if (raw) return JSON.parse(raw);
    } catch {}
    return { downloading: true, completed: true, subscriptions: true };
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "metubeplus.openSections",
        JSON.stringify(openSections),
      );
    } catch {}
  }, [openSections]);

  const toggleSection = (key: keyof typeof openSections) =>
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));

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

  // settingsOpen / onCloseSettings are owned by App.tsx (gear button lives in nav)

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

    listCategories().then(setCategoryTree).catch(console.error);
  }, []);

  // Auto-dismiss the status toast (used by Copy URL feedback).
  useEffect(() => {
    if (!statusToast) return;
    const t = setTimeout(() => setStatusToast(null), 2000);
    return () => clearTimeout(t);
  }, [statusToast]);

  // Refresh the category tree whenever a new download lands so freshly-typed
  // categories show up as autocomplete options on the next submission.
  const refreshCategoryTree = () => {
    listCategories().then(setCategoryTree).catch(console.error);
  };

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
        category: categoryValue.category || null,
        subcategory: categoryValue.subcategory || null,
        tag: categoryValue.tag || null,
      });
      setUrl("");
      refreshCategoryTree();
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
          await downloadPlaylist(
            trimmed,
            formatSpec,
            categoryValue.category || null,
            categoryValue.subcategory || null,
            categoryValue.tag || null,
          );
          setUrl("");
          refreshCategoryTree();
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
        download_existing: subDownloadExisting,
        notify: subNotify,
        category: categoryValue.category || null,
        subcategory: categoryValue.subcategory || null,
        tag: categoryValue.tag || null,
      });
      dispatchSubs({ type: "ADD", sub });
      setUrl("");
      refreshCategoryTree();
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
    setStatusToast(`Copied ${downloads.length} URL(s) to clipboard`);
  };

  // Copy a single URL (download row or subscription row) and show feedback.
  const handleCopyUrl = async (target: string, label: string) => {
    try {
      await navigator.clipboard.writeText(target);
      setStatusToast(`Copied ${label} URL`);
    } catch (err) {
      console.error(err);
      setStatusToast("Copy failed — clipboard blocked");
    }
  };

  // Trigger a browser save of a completed download. Replaces the legacy
  // "open in file explorer" action which only worked when the backend ran on
  // the same machine as the user.
  const handleDownloadFile = (id: number, title: string | null) => {
    const a = document.createElement("a");
    a.href = downloadFileUrl(id);
    // Hint to the browser this is a save, not a navigation. The server also
    // sets Content-Disposition: attachment, so this is belt-and-braces.
    a.setAttribute("download", title ?? "download");
    document.body.appendChild(a);
    a.click();
    a.remove();
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

  // ── Report stats to App nav ───────────────────────────────────────────────
  useEffect(() => {
    activeDownloadCount?.(activeDownloads.length);
    totalSpeedReport?.(totalSpeed, speedUnit);
  }, [activeDownloads.length, totalSpeed, speedUnit]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.app}>
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

          {/* ── Subscribe-only toggles (ignored by the Download button) ── */}
          <div className={styles.subscribeOptions}>
            <label>
              <input
                type="checkbox"
                checked={subDownloadExisting}
                onChange={(e) => setSubDownloadExisting(e.target.checked)}
              />
              Download existing playlist videos
            </label>
            <label>
              <input
                type="checkbox"
                checked={subNotify}
                onChange={(e) => setSubNotify(e.target.checked)}
              />
              Get notifications for this subscription
            </label>
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

          {/* Category / subcategory / tag — applied to both Download and
              Subscribe submissions in this row. */}
          <CategoryPicker
            value={categoryValue}
            onChange={setCategoryValue}
            tree={categoryTree}
          />

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
            <button
              type="button"
              className={styles.sectionToggle}
              onClick={() => toggleSection("downloading")}
              aria-expanded={openSections.downloading}
              title={openSections.downloading ? "Collapse" : "Expand"}
            >
              <ChevronIcon open={openSections.downloading} />
              <h2 className={styles.sectionTitle}>Downloading</h2>
              {activeDownloads.length > 0 && (
                <span className={styles.sectionCount}>{activeDownloads.length}</span>
              )}
            </button>
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

          {!openSections.downloading ? null : loadingDownloads ? (
            <div className={styles.tableScroll}><table className={styles.table}>
              <tbody>
                <SkeletonRow />
                <SkeletonRow />
              </tbody>
            </table></div>
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
            <div className={styles.tableScroll}><table className={styles.table}>
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
                    <td className={`${styles.metaCell} ${styles.qualityCell}`} title={qualityLabel(d)}>{qualityLabel(d)}</td>
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
            </table></div>
          )}
        </section>

        {/* ── Completed section ── */}
        <section className={styles.tableSection}>
          <div className={styles.sectionHeader}>
            <button
              type="button"
              className={styles.sectionToggle}
              onClick={() => toggleSection("completed")}
              aria-expanded={openSections.completed}
              title={openSections.completed ? "Collapse" : "Expand"}
            >
              <ChevronIcon open={openSections.completed} />
              <h2 className={styles.sectionTitle}>Completed</h2>
              {completedDownloads.length > 0 && (
                <span className={styles.sectionCount}>{completedDownloads.length}</span>
              )}
            </button>
          </div>
          {openSections.completed && (
          <div className={styles.sectionBody}>
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
            <div className={styles.tableScroll}><table className={styles.table}>
              <colgroup>
                <col style={{ width: "36px" }} />
                <col style={{ width: "100%" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "150px" }} />
                <col style={{ width: "200px" }} />
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
                          {d.status === "completed" && d.output_path ? (
                            <button
                              type="button"
                              className={styles.videoTitleLink}
                              title={`Play ${d.title ?? d.url}`}
                              onClick={() =>
                                window.open(`/api/downloads/${d.id}/stream`, "_blank")
                              }
                            >
                              {d.title ?? d.url}
                            </button>
                          ) : (
                            <span className={styles.videoTitle} title={d.title ?? d.url}>
                              {d.title ?? d.url}
                            </span>
                          )}
                          {d.status === "failed" && d.error_message && (
                            <span className={styles.errorInline}>{d.error_message}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={styles.metaCell}>
                      {d.vcodec === "none" ? "Audio" : "Video"}
                    </td>
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
                              onClick={() => handleDownloadFile(d.id, d.title)}
                              title="Download file"
                            >
                              <DownloadIcon />
                            </button>
                          </>
                        )}
                        <button
                          className={styles.iconBtn}
                          onClick={() => handleCopyUrl(d.url, "video")}
                          title="Copy video URL"
                        >
                          <CopyIcon />
                        </button>
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
            </table></div>
          )}
          </div>
          )}
        </section>

        {/* ── Subscriptions section ── */}
        <section className={styles.tableSection}>
          <div className={styles.sectionHeader}>
            <button
              type="button"
              className={styles.sectionToggle}
              onClick={() => toggleSection("subscriptions")}
              aria-expanded={openSections.subscriptions}
              title={openSections.subscriptions ? "Collapse" : "Expand"}
            >
              <ChevronIcon open={openSections.subscriptions} />
              <h2 className={styles.sectionTitle}>Subscriptions</h2>
              {subs.length > 0 && (
                <span className={styles.sectionCount}>{subs.length}</span>
              )}
            </button>
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

          {openSections.subscriptions && (
          <div className={styles.sectionBody}>
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
            <div className={styles.tableScroll}><table className={styles.table}>
              <tbody>
                <SkeletonRow />
                <SkeletonRow />
              </tbody>
            </table></div>
          ) : subs.length === 0 && !addSubOpen ? (
            <div className={styles.emptyState}>
              <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0 1 18 14.158V11a6 6 0 0 0-4-5.659V5a2 2 0 1 0-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
              </svg>
              <p className={styles.emptyTitle}>No subscriptions</p>
              <p className={styles.emptyHint}>Subscribe to a playlist or channel to auto-download new videos.</p>
            </div>
          ) : (
            <div className={styles.tableScroll}><table className={styles.table}>
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
                          onClick={() => handleCopyUrl(s.url, "playlist")}
                          title="Copy playlist URL"
                        >
                          <CopyIcon />
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
            </table></div>
          )}
          </div>
          )}
        </section>
      </main>

      {/* ── Status toast (Copy URL feedback, etc.) ── */}
      {statusToast && (
        <div className={styles.statusToast} role="status">
          {statusToast}
        </div>
      )}

      {/* ── Settings modal ── */}
      {settingsOpen && <Settings onClose={onCloseSettings} />}
    </div>
  );
}
