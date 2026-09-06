import { useEffect, useReducer, useState } from "react";

import { SkeletonRow } from "@/components/Skeleton";
import StatsMeter from "@/components/StatsMeter";
import { useUiPrefs, type SectionId } from "@/ui/UiPrefsContext";
import {
  createDownload,
  deleteDownload,
  downloadFileUrl,
  downloadPlaylist,
  getDownloadsStatus,
  listDownloads,
  listGroupedDownloads,
  type PlaylistEntry,
  pauseAllDownloads,
  previewPlaylist,
  reorderQueue,
  resumeIncompleteDownloads,
  retryDownload,
} from "@/api/downloads";
import { resolveMetadata } from "@/api/metadata";
import { getSettings, updateSettings } from "@/api/settings";
import {
  checkSubscription,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  regenerateArtwork,
  updateSubscription,
} from "@/api/subscriptions";
import {
  type DownloadCanceledPayload,
  type DownloadFailedPayload,
  type DownloadInfo,
  type DownloadsPausedPayload,
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

const ImageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L3 21" />
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

const CaretIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 15 12 9 18 15" />
  </svg>
);

// ── Section reorder control ───────────────────────────────────────────────────
// Two small up/down buttons in a section header — swap this section with its
// neighbour in the persisted order. Simpler and more touch-friendly than
// drag-and-drop, and matches "move up / down".

function ReorderControls({
  id,
  order,
  move,
}: {
  id: SectionId;
  order: SectionId[];
  move: (id: SectionId, dir: -1 | 1) => void;
}) {
  const i = order.indexOf(id);
  return (
    <div className={styles.reorder}>
      <button
        type="button"
        className={styles.reorderBtn}
        disabled={i <= 0}
        onClick={() => move(id, -1)}
        title="Move section up"
        aria-label="Move section up"
      >
        <CaretIcon />
      </button>
      <button
        type="button"
        className={`${styles.reorderBtn} ${styles.reorderBtnDown}`}
        disabled={i < 0 || i >= order.length - 1}
        onClick={() => move(id, 1)}
        title="Move section down"
        aria-label="Move section down"
      >
        <CaretIcon />
      </button>
    </div>
  );
}

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

// yt-dlp emits speeds like "1.23MiB/s" / "812.00KiB/s" — parse to bytes/sec so
// the stats meter can total them regardless of each row's unit.
function parseSpeedBps(s: string | null | undefined): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([KMGT])?i?B\/s/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const u = (m[2] || "").toUpperCase();
  const mult =
    u === "T" ? 1024 ** 4 : u === "G" ? 1024 ** 3 : u === "M" ? 1024 ** 2 : u === "K" ? 1024 : 1;
  return n * mult;
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

// Subscription check interval is stored in minutes; the UI works in days.
const MINUTES_PER_DAY = 1440;

function daysToMinutes(days: string | number): number {
  const d = parseFloat(String(days));
  if (!Number.isFinite(d) || d <= 0) return MINUTES_PER_DAY;
  return Math.max(1, Math.round(d * MINUTES_PER_DAY));
}

function minutesToDaysInput(minutes: number | string): string {
  const m = parseInt(String(minutes), 10);
  if (!Number.isFinite(m) || m <= 0) return "1";
  const days = m / MINUTES_PER_DAY;
  return String(Number(days.toFixed(2)));
}

function formatInterval(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  const days = minutes / MINUTES_PER_DAY;
  if (days >= 1) {
    const rounded = Number(days.toFixed(days % 1 === 0 ? 0 : 1));
    return `${rounded} day${rounded === 1 ? "" : "s"}`;
  }
  const hours = minutes / 60;
  if (hours >= 1) {
    const rounded = Number(hours.toFixed(hours % 1 === 0 ? 0 : 1));
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
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

export default function Dashboard({ settingsOpen: _settingsOpen, onCloseSettings: _onCloseSettings, activeDownloadCount, totalSpeedReport }: DashboardProps) {
  // ── UI preferences (stats meter + section order) ──────────────────────────
  const { statsMeter: showStatsMeter, sectionOrder, moveSection } = useUiPrefs();
  const sectionOrderStyle = (id: SectionId) => ({ order: sectionOrder.indexOf(id) + 1 });

  // ── URL / format state ────────────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [type, setType] = useState("video");
  const [quality, setQuality] = useState("best");
  const [format, setFormat] = useState("auto");
  const [codec, setCodec] = useState("auto");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
      const raw = localStorage.getItem("streamsnap.openSections");
      if (raw) return JSON.parse(raw);
    } catch {}
    return { downloading: true, completed: true, subscriptions: true };
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "streamsnap.openSections",
        JSON.stringify(openSections),
      );
    } catch {}
  }, [openSections]);

  const toggleSection = (key: keyof typeof openSections) =>
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  // ── Subscription group collapse state ────────────────────────────────────────
  // Tracks which groups are explicitly CLOSED. Groups are open by default.
  // Persisted to localStorage.
  const [closedSubGroups, setClosedSubGroups] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem("streamsnap.closedSubGroups");
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set();
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "streamsnap.closedSubGroups",
        JSON.stringify(Array.from(closedSubGroups)),
      );
    } catch {}
  }, [closedSubGroups]);

  const isSubGroupOpen = (subId: number) => !closedSubGroups.has(subId);

  const toggleSubGroup = (subId: number) => {
    setClosedSubGroups((prev) => {
      const next = new Set(prev);
      if (next.has(subId)) next.delete(subId);
      else next.add(subId);
      return next;
    });
  };

  // ── Subscription metadata (title, etc.) ──────────────────────────────────────
  const [subMetadata, setSubMetadata] = useState<
    Map<number, { subscription_id: number; subscription_title: string }>
  >(new Map());

  // ── Advanced options state ────────────────────────────────────────────────
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState("Default");
  const [subCheckInterval, setSubCheckInterval] = useState("1"); // days
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
  const [subInterval, setSubInterval] = useState("1"); // days
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

  // ── Playlist review modal ────────────────────────────────────────────────
  // Shown before a playlist download OR before a subscription that backfills
  // existing videos, so the user can drop entries first.
  const [playlistReview, setPlaylistReview] = useState<{
    mode: "download" | "subscribe";
    sourceUrl: string;
    title: string;
    entries: PlaylistEntry[]; // working list the user prunes
    allEntries: PlaylistEntry[]; // full list from preview (subscribe backfill)
    subDraft?: {
      check_interval_minutes: number;
      format_spec: string;
      notify: boolean;
    };
  } | null>(null);
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [resumingStalled, setResumingStalled] = useState(false);
  const [pausingAll, setPausingAll] = useState(false);
  const [downloadsPaused, setDownloadsPaused] = useState<{
    paused: boolean;
    reason: string | null;
  }>({ paused: false, reason: null });

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
          setSubCheckInterval(minutesToDaysInput(settings.subscription_check_interval_minutes));
        if (settings.download_folder)
          setDownloadFolder(settings.download_folder);
        if (settings.option_presets)
          setOptionPresets(settings.option_presets);
      })
      .catch(console.error);

    getDownloadsStatus()
      .then((s) => setDownloadsPaused({ paused: s.paused, reason: s.reason }))
      .catch(console.error);

    // Load subscription metadata for grouping the Completed section
    listGroupedDownloads()
      .then((grouped) => {
        const metadata = new Map(
          grouped.by_subscription.map((g) => [
            g.subscription_id,
            {
              subscription_id: g.subscription_id,
              subscription_title: g.subscription_title,
            },
          ])
        );
        setSubMetadata(metadata);
      })
      .catch(console.error);
  }, []);

  // Auto-dismiss the status toast (used by Copy URL feedback).
  useEffect(() => {
    if (!statusToast) return;
    const t = setTimeout(() => setStatusToast(null), 2000);
    return () => clearTimeout(t);
  }, [statusToast]);

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
    socket.on(WS_EVENTS.DOWNLOADS_PAUSED, (data: DownloadsPausedPayload) => {
      setDownloadsPaused({ paused: data.paused, reason: data.reason });
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
      socket.off(WS_EVENTS.DOWNLOADS_PAUSED);
      socket.off(WS_EVENTS.SUBSCRIPTION_CHECKED);
    };
  }, []);

  // ── Derived stats ─────────────────────────────────────────────────────────
  // In-progress downloads float to the top; queued rows follow in queue order
  // (queue_position ascending, nulls last), which is what the user reorders.
  const activeDownloads = downloads
    .filter((d) => d.status === "queued" || d.status === "downloading")
    .sort((a, b) => {
      const rank = (a.status === "downloading" ? 0 : 1) - (b.status === "downloading" ? 0 : 1);
      if (rank !== 0) return rank;
      const pa = a.queue_position ?? Number.MAX_SAFE_INTEGER;
      const pb = b.queue_position ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.id - b.id;
    });
  const queuedDownloads = activeDownloads.filter((d) => d.status === "queued");
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
  // Combined throughput in bytes/sec — unit-aware, for the stats meter.
  const downloadSpeedBps = activeDownloads.reduce(
    (sum, d) => sum + parseSpeedBps(d.speed),
    0,
  );

  // ── At-a-glance section summaries (shown in the collapsible headers) ──────
  const downloadingNow = activeDownloads.filter((d) => d.status === "downloading").length;
  const queuedNow = activeDownloads.length - downloadingNow;
  const doneCount = completedDownloadsRaw.filter((d) => d.status === "completed").length;
  const canceledCount = completedDownloadsRaw.filter((d) => d.status === "canceled").length;
  const doneBytes = completedDownloadsRaw.reduce(
    (sum, d) => sum + (d.status === "completed" ? d.filesize ?? 0 : 0),
    0,
  );
  const activeSubCount = subs.filter((s) => s.is_active).length;
  const pausedSubCount = subs.length - activeSubCount;

  const downloadingSummary = [
    downloadingNow > 0 ? `${downloadingNow} downloading` : null,
    queuedNow > 0 ? `${queuedNow} queued` : null,
    totalSpeed > 0 ? `${totalSpeed.toFixed(1)} ${speedUnit}` : null,
    downloadsPaused.paused ? "paused" : null,
  ].filter(Boolean).join(" · ") || "nothing in the queue";

  const completedSummary = [
    doneCount > 0 ? `${doneCount} done` : null,
    failedDownloads.length > 0 ? `${failedDownloads.length} failed` : null,
    canceledCount > 0 ? `${canceledCount} canceled` : null,
    doneBytes > 0 ? formatBytes(doneBytes) : null,
  ].filter(Boolean).join(" · ") || "nothing yet";

  const subscriptionsSummary = subs.length === 0
    ? "none yet"
    : [
        activeSubCount > 0 ? `${activeSubCount} active` : null,
        pausedSubCount > 0 ? `${pausedSubCount} paused` : null,
      ].filter(Boolean).join(" · ");

  // ── Helper: organize completed downloads by subscription ──────────────────────
  const groupedCompleted = (() => {
    const subGroups: Map<number, DownloadInfo[]> = new Map();
    const manualDownloads: DownloadInfo[] = [];

    for (const d of completedDownloads) {
      if (d.subscription_id !== null && d.subscription_id !== undefined) {
        if (!subGroups.has(d.subscription_id)) {
          subGroups.set(d.subscription_id, []);
        }
        subGroups.get(d.subscription_id)!.push(d);
      } else {
        manualDownloads.push(d);
      }
    }

    return { subGroups, manualDownloads };
  })();

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

      // Playlist detected — fetch its videos and let the user review/remove
      // entries before anything is enqueued.
      if (message === "PLAYLIST_URL") {
        try {
          setPlaylistLoading(true);
          setPlaylistError(null);
          const preview = await previewPlaylist(trimmed);
          setPlaylistReview({
            mode: "download",
            sourceUrl: trimmed,
            title: preview.title,
            entries: preview.entries,
            allEntries: preview.entries,
          });
          return;
        } catch (playlistErr) {
          let plMsg = String(playlistErr);
          try {
            const body = JSON.parse(plMsg.replace(/^ApiError: /, ""));
            if (body?.detail) plMsg = body.detail;
          } catch {}
          setSubmitError(plMsg);
          return;
        } finally {
          setPlaylistLoading(false);
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

    const draft = {
      check_interval_minutes: daysToMinutes(subCheckInterval),
      format_spec: buildFormatSpec(type, quality, format, codec),
      notify: subNotify,
    };

    try {
      // "Download existing" → review the video list before backfilling.
      if (subDownloadExisting) {
        setPlaylistLoading(true);
        setPlaylistError(null);
        const preview = await previewPlaylist(trimmed);
        setPlaylistReview({
          mode: "subscribe",
          sourceUrl: trimmed,
          title: preview.title,
          entries: preview.entries,
          allEntries: preview.entries,
          subDraft: draft,
        });
        return;
      }

      const sub = await createSubscription({
        url: trimmed,
        ...draft,
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
      setPlaylistLoading(false);
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

  // Move a queued download up/down the run order. Reorders the whole queued
  // list and pushes it to the server; the WS updates reconcile.
  const handleMoveQueued = async (id: number, dir: -1 | 1) => {
    const order = queuedDownloads.map((d) => d.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    // optimistic: assign positions 1..N in the new order
    order.forEach((did, idx) =>
      dispatchDownloads({ type: "UPDATE", patch: { id: did, queue_position: idx + 1 } }),
    );
    try {
      await reorderQueue(order);
    } catch (err) {
      console.error(err);
      listDownloads().then((d) => dispatchDownloads({ type: "SET", downloads: d })).catch(console.error);
    }
  };

  // ── Handlers: bulk actions ────────────────────────────────────────────────
  const handleClearSelected = async (ids: Set<number>) => {
    for (const id of ids) {
      await handleDelete(id);
    }
  };

  // If any rows in `candidates` are checked, act on just those; otherwise
  // act on the whole set ("nothing selected → do everything").
  const resolveTargets = <T extends { id: number },>(candidates: T[]): T[] => {
    const picked = candidates.filter((d) => selectedCompleted.has(d.id));
    return picked.length > 0 ? picked : candidates;
  };

  const completedOnly = completedDownloads.filter((d) => d.status === "completed");
  const hasCompletedSelection = completedOnly.some((d) => selectedCompleted.has(d.id));
  const hasFailedSelection = failedDownloads.some((d) => selectedCompleted.has(d.id));

  const handleClearCompleted = async () => {
    for (const d of resolveTargets(completedOnly)) {
      await handleDelete(d.id);
    }
  };

  const handleClearFailed = async () => {
    for (const d of resolveTargets(failedDownloads)) {
      await handleDelete(d.id);
    }
  };

  const handleRetryFailed = async () => {
    for (const d of resolveTargets(failedDownloads)) {
      try {
        const info = await retryDownload(d.id);
        dispatchDownloads({ type: "UPDATE", patch: info });
        setSelectedCompleted((prev) => {
          const n = new Set(prev);
          n.delete(d.id);
          return n;
        });
      } catch (e) {
        console.error("Retry failed for", d.url, e);
      }
    }
  };

  const handleResumeStalled = async () => {
    setResumingStalled(true);
    try {
      const res = await resumeIncompleteDownloads();
      setDownloadsPaused({ paused: res.paused, reason: null });
      const data = await listDownloads();
      dispatchDownloads({ type: "SET", downloads: data });
    } catch (e) {
      console.error(e);
    } finally {
      setResumingStalled(false);
    }
  };

  const handlePauseAll = async () => {
    setPausingAll(true);
    try {
      const res = await pauseAllDownloads();
      setDownloadsPaused({ paused: res.paused, reason: null });
    } catch (e) {
      console.error(e);
    } finally {
      setPausingAll(false);
    }
  };

  const handleRetryOne = async (id: number) => {
    try {
      const info = await retryDownload(id);
      dispatchDownloads({ type: "UPDATE", patch: info });
      setSelectedCompleted((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    } catch (e) {
      console.error("Retry failed for", id, e);
    }
  };

  // ── Handlers: advanced options save ──────────────────────────────────────
  const handleSaveSettings = async () => {
    await updateSettings({
      subscription_check_interval_minutes: String(daysToMinutes(subCheckInterval)),
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

  // ── Handlers: playlist review ────────────────────────────────────────────
  const removePlaylistEntry = (entryUrl: string) => {
    setPlaylistReview((prev) =>
      prev ? { ...prev, entries: prev.entries.filter((e) => e.url !== entryUrl) } : prev,
    );
  };

  const confirmPlaylistReview = async () => {
    if (!playlistReview) return;
    if (playlistReview.mode === "download" && playlistReview.entries.length === 0) return;

    setPlaylistBusy(true);
    setPlaylistError(null);
    try {
      if (playlistReview.mode === "download") {
        const formatSpec = buildFormatSpec(type, quality, format, codec);
        await downloadPlaylist(playlistReview.sourceUrl, formatSpec, {
          title: playlistReview.title,
          entries: playlistReview.entries,
        });
      } else {
        const sub = await createSubscription({
          url: playlistReview.sourceUrl,
          ...playlistReview.subDraft!,
          download_existing: true,
          download_video_ids: playlistReview.entries.map((e) => e.id),
          playlist_title: playlistReview.title,
          entries: playlistReview.allEntries,
        });
        dispatchSubs({ type: "ADD", sub });
        setAddSubOpen(false);
      }
      setPlaylistReview(null);
      setUrl("");
    } catch (e) {
      let msg = String(e);
      try {
        const body = JSON.parse(msg.replace(/^ApiError: /, ""));
        if (body?.detail) msg = body.detail;
      } catch {}
      setPlaylistError(msg);
    } finally {
      setPlaylistBusy(false);
    }
  };

  // Clipboard helper with execCommand fallback for when the document lacks focus.
  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
  };

  const handleCopyUrls = () => {
    const allUrls = downloads.map((d) => d.url).join("\n");
    copyText(allUrls).catch(console.error);
    setStatusToast(`Copied ${downloads.length} URL(s) to clipboard`);
  };

  // Copy a single URL (download row or subscription row) and show feedback.
  const handleCopyUrl = async (target: string, label: string) => {
    try {
      await copyText(target);
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

    const draft = {
      check_interval_minutes: daysToMinutes(subInterval),
      format_spec: subFormat,
      notify: subNotify,
    };

    try {
      if (subDownloadExisting) {
        setPlaylistLoading(true);
        setPlaylistError(null);
        const preview = await previewPlaylist(trimmed);
        setPlaylistReview({
          mode: "subscribe",
          sourceUrl: trimmed,
          title: preview.title,
          entries: preview.entries,
          allEntries: preview.entries,
          subDraft: draft,
        });
        setSubUrl("");
        return;
      }

      const sub = await createSubscription({
        url: trimmed,
        ...draft,
        download_existing: false,
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
      setPlaylistLoading(false);
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

  const [artworkSubId, setArtworkSubId] = useState<number | null>(null);
  const handleRegenArtwork = async (id: number) => {
    setArtworkSubId(id);
    try {
      await regenerateArtwork(id);
      setStatusToast("Artwork queued — poster.jpg / background.jpg will land in the show folder");
    } catch (err) {
      console.error(err);
      setStatusToast("Could not fetch artwork");
    } finally {
      setArtworkSubId(null);
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
        {downloadsPaused.paused && (
          <div className={styles.pausedBanner} role="alert">
            <div className={styles.pausedBannerText}>
              <strong>Downloads paused.</strong>{" "}
              {downloadsPaused.reason ??
                "Resolve the issue, then resume."}
            </div>
            <button
              className={styles.pausedBannerBtn}
              onClick={handleResumeStalled}
              disabled={resumingStalled}
            >
              {resumingStalled ? "Resuming…" : "Resume downloads"}
            </button>
          </div>
        )}

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

          {playlistLoading && (
            <p className={styles.loadingMsg}>
              Reading playlist… large channels can take a minute.
            </p>
          )}
          {submitError && (
            <p className={styles.errorMsg}>{submitError}</p>
          )}
          {/* Advanced options (collapsible) */}
          <div className={styles.advancedInline}>
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
            >
              <span className={styles.advancedToggleIcon}>
                {advancedOpen ? "▾" : "▸"}
              </span>
              Advanced options
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
                      Subscription Check (days)
                      <input
                        className={styles.advancedInput}
                        type="number"
                        min="0.25"
                        step="0.25"
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
        </div>

        {showStatsMeter && (
          <StatsMeter
            speedBps={downloadSpeedBps}
            downloading={downloadingNow}
            queued={queuedNow}
            completedBytes={doneBytes}
          />
        )}

        {/* ── Downloading section ── */}
        <section className={styles.tableSection} style={sectionOrderStyle("downloading")}>
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
              <span className={styles.sectionSummary}>{downloadingSummary}</span>
            </button>
            <div className={styles.sectionActions}>
              <ReorderControls id="downloading" order={sectionOrder} move={moveSection} />
              <button
                className={styles.ghostBtn}
                disabled={selectedActive.size === 0}
                onClick={() => handleClearSelected(selectedActive)}
              >
                Clear selected
              </button>
              <button
                className={styles.ghostBtn}
                onClick={handlePauseAll}
                disabled={pausingAll || activeDownloads.length === 0}
                title="Pause all active and queued downloads"
              >
                {pausingAll ? "Pausing…" : "Pause all"}
              </button>
              <button
                className={styles.ghostBtn}
                onClick={handleResumeStalled}
                disabled={resumingStalled || activeDownloads.length === 0}
                title="Re-queue downloads that stalled (e.g. after a restart)"
              >
                {resumingStalled ? "Resuming…" : "Resume stalled"}
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
                <col style={{ width: "auto" }} />
                <col style={{ width: "60px" }} />
                <col style={{ width: "96px" }} />
                <col style={{ width: "92px" }} />
                <col style={{ width: "52px" }} />
                <col style={{ width: "84px" }} />
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
                  <tr key={d.id} className={d.status === "queued" ? styles.rowQueued : ""}>
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
                    <td className={styles.metaCell} data-label="Type">
                      {d.vcodec === "none" ? "Audio" : "Video"}
                    </td>
                    <td className={`${styles.metaCell} ${styles.qualityCell}`} data-label="Quality" title={qualityLabel(d)}>{qualityLabel(d)}</td>
                    <td className={styles.metaCell} data-label="Speed">{d.speed ?? "\u2014"}</td>
                    <td className={styles.metaCell} data-label="ETA">
                      {d.eta != null ? `${d.eta}s` : "\u2014"}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        {d.status === "queued" && queuedDownloads.length > 1 && (
                          <div className={styles.queueMove}>
                            <button
                              type="button"
                              className={styles.queueMoveBtn}
                              disabled={queuedDownloads[0]?.id === d.id}
                              onClick={() => handleMoveQueued(d.id, -1)}
                              title="Move up in queue"
                              aria-label="Move up in queue"
                            >
                              <CaretIcon />
                            </button>
                            <button
                              type="button"
                              className={`${styles.queueMoveBtn} ${styles.queueMoveBtnDown}`}
                              disabled={queuedDownloads[queuedDownloads.length - 1]?.id === d.id}
                              onClick={() => handleMoveQueued(d.id, 1)}
                              title="Move down in queue"
                              aria-label="Move down in queue"
                            >
                              <CaretIcon />
                            </button>
                          </div>
                        )}
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
        <section className={styles.tableSection} style={sectionOrderStyle("completed")}>
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
              <span className={styles.sectionSummary}>{completedSummary}</span>
            </button>
            <div className={styles.sectionActions}>
              <ReorderControls id="completed" order={sectionOrder} move={moveSection} />
            </div>
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
              disabled={completedOnly.length === 0}
              onClick={handleClearCompleted}
              title={hasCompletedSelection ? "Clear the selected completed downloads" : "Clear all completed downloads"}
            >
              {hasCompletedSelection ? "Clear selected completed" : "Clear completed"}
            </button>
            <button
              className={styles.ghostBtn}
              disabled={failedDownloads.length === 0}
              onClick={handleClearFailed}
              title={hasFailedSelection ? "Clear the selected failed downloads" : "Clear all failed downloads"}
            >
              {hasFailedSelection ? "Clear selected failed" : "Clear failed"}
            </button>
            <button
              className={styles.ghostBtn}
              disabled={failedDownloads.length === 0}
              onClick={handleRetryFailed}
              title={hasFailedSelection ? "Re-queue the selected failed downloads" : "Re-queue all failed downloads"}
            >
              {hasFailedSelection ? "Retry selected" : "Retry failed"}
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
            <div className={styles.completedGroupsContainer}>
              {/* ── Subscription groups ── */}
              {Array.from(groupedCompleted.subGroups.entries()).map(([subId, dlsInGroup]) => {
                const subMeta = subMetadata.get(subId);
                const subTitle = subMeta?.subscription_title || `Subscription ${subId}`;
                const isOpen = isSubGroupOpen(subId);
                return (
                  <div key={`sub-${subId}`} className={styles.downloadGroup}>
                    <button
                      type="button"
                      className={styles.groupHeader}
                      onClick={() => toggleSubGroup(subId)}
                    >
                      <ChevronIcon open={isOpen} />
                      <span className={styles.groupTitle}>{subTitle}</span>
                      <span className={styles.groupCount}>{dlsInGroup.length}</span>
                    </button>
                    {isOpen && (
                      <div className={styles.tableScroll}>
                        <table className={styles.table}>
                          <colgroup>
                            <col style={{ width: "36px" }} />
                            <col style={{ width: "auto" }} />
                            <col style={{ width: "64px" }} />
                            <col style={{ width: "92px" }} />
                            <col style={{ width: "128px" }} />
                            <col style={{ width: "148px" }} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>
                                <input
                                  type="checkbox"
                                  className={styles.checkbox}
                                  checked={dlsInGroup.length > 0 && dlsInGroup.every((d) => selectedCompleted.has(d.id))}
                                  onChange={() => toggleAllSelection(dlsInGroup, selectedCompleted, setSelectedCompleted)}
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
                            {dlsInGroup.map((d) => (
                              <tr key={d.id} className={d.status === "failed" ? styles.rowFailed : ""}>
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
                                          onClick={() => window.open(`/api/downloads/${d.id}/stream`, "_blank")}
                                          title={`Play ${d.title ?? d.url}`}
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
                                <td className={styles.metaCell} data-label="Type">{d.vcodec === "none" ? "Audio" : "Video"}</td>
                                <td className={styles.metaCell} data-label="File size">{formatBytes(d.filesize)}</td>
                                <td className={styles.metaCell} data-label="Downloaded">{formatDate(d.updated_at)}</td>
                                <td>
                                  <div className={styles.rowActions}>
                                    {d.status === "completed" && d.output_path && (
                                      <>
                                        <button
                                          className={styles.iconBtn}
                                          onClick={() => window.open(`/api/downloads/${d.id}/stream`, "_blank")}
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
                                    {(d.status === "failed" || d.status === "canceled") && (
                                      <button
                                        className={styles.iconBtn}
                                        onClick={() => handleRetryOne(d.id)}
                                        title="Retry this download"
                                      >
                                        <RefreshIcon />
                                      </button>
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
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ── "Other Completed Downloads" group for manual downloads ── */}
              {groupedCompleted.manualDownloads.length > 0 && (
                <div className={styles.downloadGroup}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    onClick={() => toggleSubGroup(0)}
                  >
                    <ChevronIcon open={isSubGroupOpen(0)} />
                    <span className={styles.groupTitle}>Other Completed Downloads</span>
                    <span className={styles.groupCount}>{groupedCompleted.manualDownloads.length}</span>
                  </button>
                  {isSubGroupOpen(0) && (
                    <div className={styles.tableScroll}>
                      <table className={styles.table}>
                        <colgroup>
                          <col style={{ width: "36px" }} />
                          <col style={{ width: "auto" }} />
                          <col style={{ width: "64px" }} />
                          <col style={{ width: "92px" }} />
                          <col style={{ width: "128px" }} />
                          <col style={{ width: "148px" }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>
                              <input
                                type="checkbox"
                                className={styles.checkbox}
                                checked={groupedCompleted.manualDownloads.length > 0 && groupedCompleted.manualDownloads.every((d) => selectedCompleted.has(d.id))}
                                onChange={() => toggleAllSelection(groupedCompleted.manualDownloads, selectedCompleted, setSelectedCompleted)}
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
                          {groupedCompleted.manualDownloads.map((d) => (
                            <tr key={d.id} className={d.status === "failed" ? styles.rowFailed : ""}>
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
                                        onClick={() => window.open(`/api/downloads/${d.id}/stream`, "_blank")}
                                        title={`Play ${d.title ?? d.url}`}
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
                              <td className={styles.metaCell}>{d.vcodec === "none" ? "Audio" : "Video"}</td>
                              <td className={styles.metaCell}>{formatBytes(d.filesize)}</td>
                              <td className={styles.metaCell}>{formatDate(d.updated_at)}</td>
                              <td>
                                <div className={styles.rowActions}>
                                  {d.status === "completed" && d.output_path && (
                                    <>
                                      <button
                                        className={styles.iconBtn}
                                        onClick={() => window.open(`/api/downloads/${d.id}/stream`, "_blank")}
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
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
          )}
        </section>

        {/* ── Subscriptions section ── */}
        <section className={styles.tableSection} style={sectionOrderStyle("subscriptions")}>
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
              <span className={styles.sectionSummary}>{subscriptionsSummary}</span>
            </button>
            <div className={styles.sectionActions}>
              <ReorderControls id="subscriptions" order={sectionOrder} move={moveSection} />
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
                  Interval (days)
                  <input
                    className={styles.advancedInput}
                    type="number"
                    min="0.25"
                    step="0.25"
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
                <col style={{ width: "auto" }} />
                <col style={{ width: "168px" }} />
                <col style={{ width: "92px" }} />
                <col style={{ width: "128px" }} />
                <col style={{ width: "78px" }} />
                <col style={{ width: "176px" }} />
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
                  <th>Interval</th>
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
                    <td data-label="URL">
                      <span
                        className={`${styles.metaCell} ${styles.urlTruncate}`}
                        title={s.url}
                      >
                        {s.url}
                      </span>
                    </td>
                    <td className={styles.metaCell} data-label="Interval">{formatInterval(s.check_interval_minutes)}</td>
                    <td className={styles.metaCell} data-label="Last checked">
                      {formatDate(s.last_checked_at)}
                    </td>
                    <td data-label="Status">
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
                          onClick={() => handleRegenArtwork(s.id)}
                          disabled={artworkSubId === s.id}
                          title={artworkSubId === s.id ? "Fetching…" : "Fetch Plex artwork (poster + background)"}
                        >
                          <ImageIcon />
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

      {/* Settings modal lives in App.tsx so it's reachable from the Media
          tab too — keeping it here would mean unmounting it whenever the
          user switches tabs, breaking the gear button on Media. */}

      {/* ── Playlist / subscription review modal ── */}
      {playlistReview && (
        <div
          className={styles.plOverlay}
          onClick={() => !playlistBusy && setPlaylistReview(null)}
        >
          <div className={styles.plModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.plHeader}>
              <div className={styles.plHeaderText}>
                <h2 className={styles.plTitle} title={playlistReview.title}>
                  {playlistReview.title}
                </h2>
                <p className={styles.plSubtitle}>
                  {playlistReview.entries.length} video
                  {playlistReview.entries.length === 1 ? "" : "s"} — remove any you
                  don&apos;t want, then{" "}
                  {playlistReview.mode === "subscribe" ? "subscribe" : "download"}
                </p>
              </div>
              <button
                className={styles.plClose}
                onClick={() => setPlaylistReview(null)}
                disabled={playlistBusy}
                aria-label="Close"
              >
                {"×"}
              </button>
            </div>

            <div className={styles.plList}>
              {playlistReview.entries.length === 0 ? (
                <p className={styles.plEmpty}>
                  {playlistReview.mode === "subscribe"
                    ? "No videos left — subscribing will only fetch future uploads."
                    : "Every video was removed. Cancel and start over to pick again."}
                </p>
              ) : (
                playlistReview.entries.map((e, i) => (
                  <div className={styles.plRow} key={e.id || e.url}>
                    <span className={styles.plIndex}>{i + 1}</span>
                    <span className={styles.plName} title={e.title ?? e.url}>
                      {e.title ?? e.url}
                    </span>
                    {e.upload_date && (
                      <span className={styles.plDate}>{e.upload_date}</span>
                    )}
                    <button
                      className={styles.plRemove}
                      onClick={() => removePlaylistEntry(e.url)}
                      disabled={playlistBusy}
                      title="Remove from list"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))
              )}
            </div>

            {playlistError && <p className={styles.plErrorMsg}>{playlistError}</p>}

            <div className={styles.plFooter}>
              <button
                className={styles.cancelBtn}
                onClick={() => setPlaylistReview(null)}
                disabled={playlistBusy}
              >
                Cancel
              </button>
              <button
                className={styles.downloadBtn}
                onClick={confirmPlaylistReview}
                disabled={
                  playlistBusy ||
                  (playlistReview.mode === "download" &&
                    playlistReview.entries.length === 0)
                }
              >
                {playlistBusy
                  ? "Starting…"
                  : playlistReview.mode === "subscribe"
                    ? playlistReview.entries.length === 0
                      ? "Subscribe (future only)"
                      : `Subscribe & download ${playlistReview.entries.length} video${
                          playlistReview.entries.length === 1 ? "" : "s"
                        }`
                    : `Download ${playlistReview.entries.length} video${
                        playlistReview.entries.length === 1 ? "" : "s"
                      }`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
