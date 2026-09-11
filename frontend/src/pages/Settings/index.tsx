import { useEffect, useRef, useState } from "react";
import {
  backupDb,
  deleteDbBackup,
  downloadDbBackup,
  getDbSchemaVersion,
  getSettings,
  getYtdlpVersion,
  initializeDb,
  listDbBackups,
  restoreDb,
  updateSettings,
  updateYtdlp,
  uploadDbBackup,
  type DbBackupEntry,
  type DbSchemaVersionInfo,
  type YtdlpVersionInfo,
} from "@/api/settings";
import {
  type ChannelEvent,
  type ChannelKind,
  type ChannelTestResult,
  type NotificationChannel,
  CHANNEL_EVENTS,
  DEFAULT_CHANNEL_EVENTS,
  channelEvents,
  createChannel,
  deleteChannel,
  listChannels,
  sendSummaryNow,
  testChannel,
  testChannelConfig,
  updateChannel,
} from "@/api/notifications";
import { padEpisodeNumbers } from "@/api/downloads";
import { getTmdbStatus, type TmdbStatus } from "@/api/tmdb";
import { useTheme } from "@/theme/ThemeContext";
import { BACKGROUND_OPTIONS } from "@/theme/types";
import { useUiPrefs } from "@/ui/UiPrefsContext";
import styles from "./Settings.module.css";

interface SettingsState {
  // Format
  format_spec: string;
  quality_cap: string;
  prefer_codec: string;
  audio_codec: string;
  merge_container: string;
  prefer_free_formats: string;
  format_sort: string;
  // Subtitles
  write_subs: string;
  sub_langs: string;
  write_auto_subs: string;
  embed_subs: string;
  convert_subs: string;
  // Metadata & Thumbnails
  embed_thumbnail: string;
  write_thumbnail: string;
  subscription_artwork: string;
  tmdb_api_key: string;
  tmdb_language: string;
  write_info_json: string;
  write_description: string;
  embed_metadata: string;
  embed_chapters: string;
  // Post-processing
  sponsorblock_remove: string;
  ffmpeg_location: string;
  keep_video: string;
  pad_episode_numbers: string;
  // Download
  max_concurrent_downloads: string;
  concurrent_fragments: string;
  retries: string;
  fragment_retries: string;
  rate_limit: string;
  socket_timeout: string;
  continue_partial: string;
  no_overwrites: string;
  // Output
  output_template: string;
  restrict_filenames: string;
  temp_path: string;
  download_folder: string;
  // Auth
  cookies_from_browser: string;
  username: string;
  password: string;
  // Advanced
  raw_options_json: string;
  // Notification suppression
  notify_on_download_start: string;
  notify_on_complete: string;
  notify_on_failed: string;
  notify_on_playlist_complete: string;
  notify_on_new_video: string;
  notify_on_subscription_error: string;
  // Summary
  notify_summary_enabled: string;
  notify_summary_interval_hours: string;
}

const DEFAULTS: SettingsState = {
  format_spec: "bestvideo*+bestaudio/best",
  quality_cap: "",
  prefer_codec: "auto",
  audio_codec: "auto",
  merge_container: "mp4",
  prefer_free_formats: "false",
  format_sort: "",
  write_subs: "false",
  sub_langs: "en",
  write_auto_subs: "false",
  embed_subs: "false",
  convert_subs: "",
  embed_thumbnail: "false",
  write_thumbnail: "false",
  subscription_artwork: "true",
  tmdb_api_key: "",
  tmdb_language: "en",
  write_info_json: "false",
  write_description: "false",
  embed_metadata: "false",
  embed_chapters: "false",
  sponsorblock_remove: "",
  ffmpeg_location: "",
  keep_video: "false",
  pad_episode_numbers: "true",
  max_concurrent_downloads: "1",
  concurrent_fragments: "1",
  retries: "10",
  fragment_retries: "10",
  rate_limit: "",
  socket_timeout: "30",
  continue_partial: "true",
  no_overwrites: "false",
  output_template: "%(title)s.%(ext)s",
  restrict_filenames: "false",
  temp_path: "",
  download_folder: "./downloads",
  cookies_from_browser: "",
  username: "",
  password: "",
  raw_options_json: "",
  notify_on_download_start: "false",
  notify_on_complete: "true",
  notify_on_failed: "true",
  notify_on_playlist_complete: "true",
  notify_on_new_video: "false",
  notify_on_subscription_error: "true",
  notify_summary_enabled: "false",
  notify_summary_interval_hours: "24",
};

const TABS = [
  "Theme",
  "Format",
  "Subtitles",
  "Metadata",
  "Post-processing",
  "Download",
  "Output",
  "Auth",
  "Advanced",
  "Notifications",
] as const;

type Tab = typeof TABS[number];

interface Props {
  onClose: () => void;
}

// ── Channel kind metadata ─────────────────────────────────────────────────────

const CHANNEL_KINDS: { kind: ChannelKind; label: string; fields: { key: string; label: string; type?: string; placeholder?: string }[] }[] = [
  {
    kind: "slack",
    label: "Slack",
    fields: [{ key: "webhook_url", label: "Webhook URL", placeholder: "https://hooks.slack.com/services/..." }],
  },
  {
    kind: "discord",
    label: "Discord",
    fields: [{ key: "webhook_url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/..." }],
  },
  {
    kind: "telegram",
    label: "Telegram",
    fields: [
      { key: "bot_token", label: "Bot Token", placeholder: "123456:ABC-DEF..." },
      { key: "chat_id", label: "Chat ID", placeholder: "-1001234567890" },
    ],
  },
  {
    kind: "pushover",
    label: "Pushover",
    fields: [
      { key: "app_token", label: "App Token" },
      { key: "user_key", label: "User Key" },
    ],
  },
  {
    kind: "smtp",
    label: "Email (SMTP)",
    fields: [
      { key: "host", label: "SMTP Host", placeholder: "smtp.gmail.com" },
      { key: "port", label: "Port", placeholder: "587" },
      { key: "username", label: "Username / Email" },
      { key: "password", label: "Password", type: "password" },
      { key: "from_email", label: "From Address" },
      { key: "to_email", label: "To Address" },
    ],
  },
];

export default function Settings({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Format");
  const [s, setS] = useState<SettingsState>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── Notification channels state ───────────────────────────────────────────
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [addingKind, setAddingKind] = useState<ChannelKind | "">("");
  const [addingName, setAddingName] = useState("");
  const [addingConfig, setAddingConfig] = useState<Record<string, string>>({});
  const [addingEvents, setAddingEvents] = useState<ChannelEvent[]>([...DEFAULT_CHANNEL_EVENTS]);
  const [addingInProgress, setAddingInProgress] = useState(false);
  const [addTesting, setAddTesting] = useState(false);
  const [addTestResult, setAddTestResult] = useState<ChannelTestResult | null>(null);
  const [summaryInProgress, setSummaryInProgress] = useState(false);

  // TMDB artwork (Metadata tab)
  const [tmdbTesting, setTmdbTesting] = useState(false);
  const [tmdbStatus, setTmdbStatus] = useState<TmdbStatus | null>(null);

  // ── yt-dlp updater state ──────────────────────────────────────────────────
  const [ytdlpInfo, setYtdlpInfo] = useState<YtdlpVersionInfo | null>(null);
  const [ytdlpUpdating, setYtdlpUpdating] = useState(false);
  const [ytdlpResult, setYtdlpResult] = useState<{ updated: boolean; new_version: string } | null>(null);
  const [ytdlpError, setYtdlpError] = useState<string | null>(null);

  // ── Episode-number padding ───────────────────────────────────────────────
  const [padBusy, setPadBusy] = useState(false);
  const [padResult, setPadResult] = useState<string | null>(null);

  const handlePadEpisodes = async () => {
    setPadBusy(true);
    setPadResult(null);
    try {
      const res = await padEpisodeNumbers();
      setPadResult(
        res.renamed === 0
          ? "Nothing to rename — all episode numbers already padded."
          : `Renamed ${res.renamed} file(s).`,
      );
    } catch (e) {
      setPadResult(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setPadBusy(false);
    }
  };

  useEffect(() => {
    getSettings().then(({ settings }) => {
      setS((prev) => ({ ...prev, ...Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== null)
      ) as Partial<SettingsState> }));
    }).catch(console.error);
    listChannels().then(setChannels).catch(console.error);
    getYtdlpVersion().then(setYtdlpInfo).catch(console.error);
  }, []);

  const set = (key: keyof SettingsState, value: string) => {
    setS((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const toggle = (key: keyof SettingsState) => {
    setS((prev) => ({ ...prev, [key]: prev[key] === "true" ? "false" : "true" }));
    setSaved(false);
  };

  // TMDB connection check (Settings → Metadata). Saves first so the key the
  // user just typed is the one the backend tests.
  const handleTmdbTest = async () => {
    setTmdbTesting(true);
    setTmdbStatus(null);
    try {
      await updateSettings(s as unknown as Record<string, string>);
      setTmdbStatus(await getTmdbStatus());
    } catch (err) {
      setTmdbStatus({
        configured: true,
        ok: false,
        language: s.tmdb_language,
        error: err instanceof Error ? err.message : "TMDB test failed",
      });
    } finally {
      setTmdbTesting(false);
    }
  };

  const handleAddChannel = async () => {
    if (!addingKind || !addingName.trim()) return;
    setAddingInProgress(true);
    try {
      const ch = await createChannel({
        kind: addingKind,
        name: addingName.trim(),
        config_json: JSON.stringify(addingConfig),
        events_json: JSON.stringify(addingEvents),
      });
      setChannels((prev) => [...prev, ch]);
      setAddingKind("");
      setAddingName("");
      setAddingConfig({});
      setAddingEvents([...DEFAULT_CHANNEL_EVENTS]);
      setAddTestResult(null);
    } catch (e) { console.error(e); }
    finally { setAddingInProgress(false); }
  };

  const handleTestAddConfig = async () => {
    if (!addingKind) return;
    setAddTesting(true);
    setAddTestResult(null);
    try {
      setAddTestResult(await testChannelConfig(addingKind, addingConfig));
    } catch (e) {
      setAddTestResult({
        ok: false,
        logs: [],
        error: e instanceof Error ? e.message : "Test request failed",
      });
    } finally {
      setAddTesting(false);
    }
  };

  const handleDeleteChannel = async (id: number) => {
    try {
      await deleteChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch (e) { console.error(e); }
  };

  const handleUpdateYtdlp = async () => {
    setYtdlpUpdating(true);
    setYtdlpResult(null);
    setYtdlpError(null);
    try {
      const res = await updateYtdlp();
      setYtdlpResult({ updated: res.updated, new_version: res.new_version });
      setYtdlpInfo((prev) => prev ? { ...prev, version: res.new_version } : prev);
    } catch (e: unknown) {
      setYtdlpError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setYtdlpUpdating(false);
    }
  };

  // ── Database admin ────────────────────────────────────────────────────────
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [schemaVersion, setSchemaVersion] = useState<DbSchemaVersionInfo | null>(null);
  const [dbBackups, setDbBackups] = useState<DbBackupEntry[]>([]);
  const [dbBackupDir, setDbBackupDir] = useState<string>("");
  const [dbBusy, setDbBusy] = useState<string | null>(null);
  const [dbStatus, setDbStatus] = useState<string | null>(null);

  const refreshDbBackups = async () => {
    try {
      const list = await listDbBackups();
      setDbBackups(list.backups);
      setDbBackupDir(list.directory);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refreshDbBackups();
    getDbSchemaVersion().then(setSchemaVersion).catch(console.error);
  }, []);

  const handleBackupDb = async () => {
    setDbBusy("backup");
    setDbStatus(null);
    try {
      const res = await backupDb();
      setDbStatus(`✓ Saved ${res.name} (${(res.size / 1024).toFixed(1)} KB)`);
      await refreshDbBackups();
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Backup failed"}`);
    } finally {
      setDbBusy(null);
    }
  };

  const handleRestoreDb = async (name: string) => {
    if (!confirm(`Restore database from ${name}? Current data will be overwritten.`)) return;
    setDbBusy("restore");
    setDbStatus(null);
    try {
      await restoreDb(name);
      setDbStatus(`✓ Restored from ${name}. Reloading…`);
      // The entire in-memory UI state (Dashboard downloads, subscriptions,
      // notifications) is now out of sync with the restored DB — easier and
      // less error-prone to refresh the whole page than to invalidate every
      // store individually.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Restore failed"}`);
      setDbBusy(null);
    }
  };

  const handleInitializeDb = async () => {
    if (!confirm(
      "Initialize database? This deletes all downloads, subscriptions, seen videos, and notifications. " +
      "Notification channels and app settings are preserved. This cannot be undone."
    )) return;
    setDbBusy("init");
    setDbStatus(null);
    try {
      const res = await initializeDb();
      const parts = Object.entries(res.deleted).map(([k, v]) => `${v} ${k}`).join(", ");
      setDbStatus(`✓ Cleared: ${parts}. Reloading…`);
      // Same reasoning as restore — Dashboard still holds the wiped rows in
      // local state and APScheduler jobs were just cancelled server-side.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Initialize failed"}`);
      setDbBusy(null);
    }
  };

  const handleDeleteBackup = async (name: string) => {
    if (!confirm(`Delete backup ${name}? This cannot be undone.`)) return;
    setDbBusy("delete");
    setDbStatus(null);
    try {
      await deleteDbBackup(name);
      setDbStatus(`✓ Deleted ${name}`);
      await refreshDbBackups();
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Delete failed"}`);
    } finally {
      setDbBusy(null);
    }
  };

  const handleUploadBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setDbBusy("upload");
    setDbStatus(null);
    try {
      const res = await uploadDbBackup(file);
      setDbStatus(`✓ Uploaded ${res.name}`);
      await refreshDbBackups();
    } catch (err) {
      setDbStatus(`✕ ${err instanceof Error ? err.message : "Upload failed"}`);
    } finally {
      setDbBusy(null);
    }
  };

  const handleSendSummary = async () => {
    setSummaryInProgress(true);
    try { await sendSummaryNow(); }
    catch (e) { console.error(e); }
    finally { setSummaryInProgress(false); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(s as unknown as Record<string, string>);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const bool = (key: keyof SettingsState) => s[key] === "true";

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose}>&#x2715;</button>
        </div>

        <div className={styles.body}>
          {/* Tab bar */}
          <div className={styles.tabs}>
            {TABS.map((tab) => (
              <button
                key={tab}
                className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className={styles.content}>

            {/* ── Theme ── */}
            {activeTab === "Theme" && <ThemeTab />}

            {/* ── Format ── */}
            {activeTab === "Format" && (
              <div className={styles.fields}>
                <Field label="Format Spec" hint="yt-dlp format selector string">
                  <input className={styles.input} value={s.format_spec} onChange={(e) => set("format_spec", e.target.value)} />
                  <div className={styles.presets}>
                    <span className={styles.presetsLabel}>Presets:</span>
                    {[
                      ["Best Quality", "bestvideo*+bestaudio/best"],
                      ["1080p mp4", "bestvideo*[height<=1080]+bestaudio/best[height<=1080]"],
                      ["720p mp4", "bestvideo*[height<=720]+bestaudio/best[height<=720]"],
                      ["Audio m4a", "bestaudio[ext=m4a]/bestaudio"],
                      ["Audio opus", "bestaudio[ext=webm]/bestaudio"],
                    ].map(([label, spec]) => (
                      <button key={label} className={styles.presetBtn} onClick={() => set("format_spec", spec)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Row>
                  <Field label="Quality Cap">
                    <select className={styles.select} value={s.quality_cap} onChange={(e) => set("quality_cap", e.target.value)}>
                      <option value="">No limit</option>
                      <option value="2160">4K (2160p)</option>
                      <option value="1440">1440p</option>
                      <option value="1080">1080p</option>
                      <option value="720">720p</option>
                      <option value="480">480p</option>
                      <option value="360">360p</option>
                    </select>
                  </Field>
                  <Field label="Prefer Codec">
                    <select className={styles.select} value={s.prefer_codec} onChange={(e) => set("prefer_codec", e.target.value)}>
                      <option value="auto">Auto</option>
                      <option value="h264">H.264 (AVC)</option>
                      <option value="h265">H.265 (HEVC)</option>
                      <option value="vp9">VP9</option>
                      <option value="av1">AV1</option>
                    </select>
                  </Field>
                  <Field label="Audio Codec">
                    <select className={styles.select} value={s.audio_codec} onChange={(e) => set("audio_codec", e.target.value)}>
                      <option value="auto">Auto</option>
                      <option value="opus">Opus</option>
                      <option value="aac">AAC</option>
                      <option value="m4a">M4A</option>
                      <option value="mp3">MP3</option>
                    </select>
                  </Field>
                  <Field label="Merge Container">
                    <select className={styles.select} value={s.merge_container} onChange={(e) => set("merge_container", e.target.value)}>
                      <option value="mp4">mp4</option>
                      <option value="mkv">mkv</option>
                      <option value="webm">webm</option>
                    </select>
                  </Field>
                </Row>
                <Row>
                  <Toggle label="Prefer Free Formats" checked={bool("prefer_free_formats")} onChange={() => toggle("prefer_free_formats")} />
                </Row>
                <Field label="Format Sort" hint="Advanced: --format-sort value (e.g. res,ext:mp4:m4a)">
                  <input className={styles.input} value={s.format_sort} onChange={(e) => set("format_sort", e.target.value)} placeholder="res,ext:mp4:m4a" />
                </Field>
              </div>
            )}

            {/* ── Subtitles ── */}
            {activeTab === "Subtitles" && (
              <div className={styles.fields}>
                <Row>
                  <Toggle label="Write Subtitles" checked={bool("write_subs")} onChange={() => toggle("write_subs")} />
                  <Toggle label="Write Auto Subs" checked={bool("write_auto_subs")} onChange={() => toggle("write_auto_subs")} />
                  <Toggle label="Embed Subtitles" checked={bool("embed_subs")} onChange={() => toggle("embed_subs")} />
                </Row>
                <Field label="Subtitle Languages" hint="Comma-separated language codes (e.g. en,fr,de)">
                  <input className={styles.input} value={s.sub_langs} onChange={(e) => set("sub_langs", e.target.value)} placeholder="en" />
                </Field>
                <Field label="Convert Subtitles To">
                  <select className={styles.select} value={s.convert_subs} onChange={(e) => set("convert_subs", e.target.value)}>
                    <option value="">No conversion</option>
                    <option value="srt">SRT</option>
                    <option value="vtt">VTT</option>
                    <option value="ass">ASS</option>
                    <option value="lrc">LRC</option>
                  </select>
                </Field>
              </div>
            )}

            {/* ── Metadata & Thumbnails ── */}
            {activeTab === "Metadata" && (
              <div className={styles.fields}>
                <SectionTitle>Thumbnails</SectionTitle>
                <Row>
                  <Toggle label="Embed Thumbnail" checked={bool("embed_thumbnail")} onChange={() => toggle("embed_thumbnail")} />
                  <Toggle label="Write Thumbnail File" checked={bool("write_thumbnail")} onChange={() => toggle("write_thumbnail")} />
                </Row>
                <Row>
                  <Toggle
                    label="Subscription artwork for Plex / Jellyfin"
                    hint="Writes poster, background, logo, banner, square art and season posters into each show folder."
                    checked={s.subscription_artwork !== "false"}
                    onChange={() => toggle("subscription_artwork")}
                  />
                </Row>

                <SectionTitle>TMDB Artwork</SectionTitle>
                <p className={styles.authNote}>
                  With a TMDB key, artwork comes from The Movie Database instead of the first
                  video's thumbnail — proper poster, backdrop, clear logo, banner, square art and
                  season posters. Without a key (or when a subscription has no TMDB match) the
                  first video's thumbnail is used as before. Get a free key at
                  {" "}themoviedb.org → Settings → API.
                </p>
                <Row>
                  <Field label="TMDB API Key" hint="v3 API key or v4 read-access token">
                    <input
                      className={styles.input}
                      type="password"
                      value={s.tmdb_api_key}
                      onChange={(e) => set("tmdb_api_key", e.target.value)}
                      autoComplete="off"
                      placeholder="Leave blank to use TMDB_API_KEY from .env"
                    />
                  </Field>
                  <Field label="Artwork Language" hint="ISO 639-1 code — posters and logos prefer this language">
                    <input
                      className={styles.input}
                      value={s.tmdb_language}
                      onChange={(e) => set("tmdb_language", e.target.value)}
                      autoComplete="off"
                      placeholder="en"
                    />
                  </Field>
                </Row>
                <Row>
                  <button
                    className={styles.presetBtn}
                    type="button"
                    onClick={handleTmdbTest}
                    disabled={tmdbTesting}
                  >
                    {tmdbTesting ? "Testing…" : "Test TMDB connection"}
                  </button>
                  {tmdbStatus && (
                    <span className={styles.fieldHint} data-ok={tmdbStatus.ok}>
                      {tmdbStatus.ok
                        ? "Connected to TMDB."
                        : tmdbStatus.error || "No TMDB API key configured."}
                    </span>
                  )}
                </Row>
                <SectionTitle>Metadata Files</SectionTitle>
                <Row>
                  <Toggle label="Write Info JSON" checked={bool("write_info_json")} onChange={() => toggle("write_info_json")} />
                  <Toggle label="Write Description" checked={bool("write_description")} onChange={() => toggle("write_description")} />
                </Row>
                <SectionTitle>Embed</SectionTitle>
                <Row>
                  <Toggle label="Embed Metadata" checked={bool("embed_metadata")} onChange={() => toggle("embed_metadata")} />
                  <Toggle label="Embed Chapters" checked={bool("embed_chapters")} onChange={() => toggle("embed_chapters")} />
                </Row>
              </div>
            )}

            {/* ── Post-processing ── */}
            {activeTab === "Post-processing" && (
              <div className={styles.fields}>
                <Field label="SponsorBlock — Remove Categories" hint="Comma-separated categories to cut from video">
                  <div className={styles.checkGroup}>
                    {["sponsor", "intro", "outro", "selfpromo", "music_offtopic", "filler"].map((cat) => {
                      const active = s.sponsorblock_remove.split(",").map((c) => c.trim()).filter(Boolean).includes(cat);
                      return (
                        <label key={cat} className={styles.checkItem}>
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={active}
                            onChange={() => {
                              const cats = s.sponsorblock_remove.split(",").map((c) => c.trim()).filter(Boolean);
                              const next = active ? cats.filter((c) => c !== cat) : [...cats, cat];
                              set("sponsorblock_remove", next.join(","));
                            }}
                          />
                          {cat}
                        </label>
                      );
                    })}
                  </div>
                </Field>
                <Field label="FFmpeg Location" hint="Path to ffmpeg binary (leave empty for auto-detect)">
                  <input className={styles.input} value={s.ffmpeg_location} onChange={(e) => set("ffmpeg_location", e.target.value)} placeholder="Auto-detected" />
                </Field>
                <Row>
                  <Toggle label="Keep Original Video After Post-processing" checked={bool("keep_video")} onChange={() => toggle("keep_video")} />
                </Row>
                <Row>
                  <Toggle
                    label="Zero-pad episode numbers (Episode 1 → Episode 01)"
                    checked={s.pad_episode_numbers !== "false"}
                    onChange={() => toggle("pad_episode_numbers")}
                  />
                </Row>
                <Field label="Fix existing files" hint={padResult ?? "Apply zero-padding to every file already in the download folders"}>
                  <button
                    type="button"
                    className={styles.saveBtn}
                    disabled={padBusy}
                    onClick={handlePadEpisodes}
                  >
                    {padBusy ? "Renaming…" : "Fix episode numbers now"}
                  </button>
                </Field>
              </div>
            )}

            {/* ── Download ── */}
            {activeTab === "Download" && (
              <div className={styles.fields}>
                <Row>
                  <Field label="Concurrent Downloads" hint="How many videos download at once (1–12)">
                    <input className={styles.inputSm} type="number" min="1" max="12" value={s.max_concurrent_downloads} onChange={(e) => set("max_concurrent_downloads", e.target.value)} />
                  </Field>
                  <Field label="Concurrent Fragments" hint="Number of fragments to download in parallel">
                    <input className={styles.inputSm} type="number" min="1" max="16" value={s.concurrent_fragments} onChange={(e) => set("concurrent_fragments", e.target.value)} />
                  </Field>
                  <Field label="Retries">
                    <input className={styles.inputSm} type="number" min="0" value={s.retries} onChange={(e) => set("retries", e.target.value)} />
                  </Field>
                  <Field label="Fragment Retries">
                    <input className={styles.inputSm} type="number" min="0" value={s.fragment_retries} onChange={(e) => set("fragment_retries", e.target.value)} />
                  </Field>
                  <Field label="Socket Timeout (s)">
                    <input className={styles.inputSm} type="number" min="0" value={s.socket_timeout} onChange={(e) => set("socket_timeout", e.target.value)} />
                  </Field>
                </Row>
                <Row>
                  <Field label="Rate Limit" hint="e.g. 1M, 500K — leave empty for unlimited">
                    <input className={styles.input} value={s.rate_limit} onChange={(e) => set("rate_limit", e.target.value)} placeholder="Unlimited" />
                  </Field>
                </Row>
                <Row>
                  <Toggle label="Continue Partial Downloads" checked={bool("continue_partial")} onChange={() => toggle("continue_partial")} />
                  <Toggle label="No Overwrites" checked={bool("no_overwrites")} onChange={() => toggle("no_overwrites")} />
                </Row>
              </div>
            )}

            {/* ── Output ── */}
            {activeTab === "Output" && (
              <div className={styles.fields}>
                <Field label="Download Folder" hint="Root folder for all downloads">
                  <input className={styles.input} value={s.download_folder} onChange={(e) => set("download_folder", e.target.value)} />
                </Field>
                <Field label="Temp Path" hint="Temporary download path (empty = same as download folder)">
                  <input className={styles.input} value={s.temp_path} onChange={(e) => set("temp_path", e.target.value)} placeholder="Same as download folder" />
                </Field>
                <Field label="Output Template" hint="yt-dlp output template string">
                  <input className={styles.input} value={s.output_template} onChange={(e) => set("output_template", e.target.value)} />
                  <div className={styles.hint}>
                    Variables: <code>%(title)s</code> <code>%(uploader)s</code> <code>%(upload_date)s</code> <code>%(id)s</code> <code>%(ext)s</code> <code>%(playlist_title)s</code>
                  </div>
                </Field>
                <Row>
                  <Toggle label="Restrict Filenames" hint="Replace special characters in filenames" checked={bool("restrict_filenames")} onChange={() => toggle("restrict_filenames")} />
                </Row>
              </div>
            )}

            {/* ── Auth ── */}
            {activeTab === "Auth" && (
              <div className={styles.fields}>
                <Field label="Cookies From Browser" hint="Extract cookies from an installed browser">
                  <select className={styles.select} value={s.cookies_from_browser} onChange={(e) => set("cookies_from_browser", e.target.value)}>
                    <option value="">None</option>
                    <option value="chrome">Chrome</option>
                    <option value="firefox">Firefox</option>
                    <option value="edge">Edge</option>
                    <option value="safari">Safari</option>
                    <option value="brave">Brave</option>
                    <option value="opera">Opera</option>
                  </select>
                </Field>
                <p className={styles.authNote}>
                  Username and password are stored server-side only and never exposed to the browser after saving.
                </p>
                <Row>
                  <Field label="Username">
                    <input className={styles.input} value={s.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Password">
                    <input className={styles.input} type="password" value={s.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
                  </Field>
                </Row>
              </div>
            )}

            {/* ── Advanced ── */}
            {activeTab === "Advanced" && (
              <div className={styles.fields}>

                <SectionTitle>yt-dlp</SectionTitle>
                <div className={styles.ytdlpCard}>
                  <div className={styles.ytdlpMeta}>
                    <span className={styles.ytdlpLabel}>Installed version</span>
                    <span className={styles.ytdlpVersion}>
                      {ytdlpInfo ? ytdlpInfo.version : "…"}
                    </span>
                    {ytdlpInfo?.ytdlp_dir && (
                      <span className={styles.ytdlpDir} title={ytdlpInfo.ytdlp_dir}>
                        📁 {ytdlpInfo.ytdlp_dir}
                      </span>
                    )}
                  </div>
                  <button
                    className={styles.saveBtn}
                    onClick={handleUpdateYtdlp}
                    disabled={ytdlpUpdating}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {ytdlpUpdating ? "Updating…" : "Update to latest"}
                  </button>
                </div>
                {ytdlpResult && (
                  <p className={styles.ytdlpStatus} data-updated={ytdlpResult.updated}>
                    {ytdlpResult.updated
                      ? `✓ Updated to ${ytdlpResult.new_version}`
                      : `✓ Already up to date (${ytdlpResult.new_version})`}
                  </p>
                )}
                {ytdlpError && (
                  <p className={styles.ytdlpStatus} data-updated="false">
                    ✕ {ytdlpError}
                  </p>
                )}

                <SectionTitle>Database</SectionTitle>
                <div className={styles.ytdlpCard}>
                  <div className={styles.ytdlpMeta}>
                    <span className={styles.ytdlpLabel}>Schema version</span>
                    <span className={styles.ytdlpVersion}>
                      {schemaVersion
                        ? `${schemaVersion.current_version} / ${schemaVersion.target_version}`
                        : "…"}
                    </span>
                    {schemaVersion && !schemaVersion.up_to_date && (
                      <span style={{ color: "var(--color-warn)", fontSize: "var(--text-xs)" }}>
                        Migration pending — restart the server to apply
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.ytdlpCard}>
                  <div className={styles.ytdlpMeta}>
                    <span className={styles.ytdlpLabel}>Backups directory</span>
                    <span className={styles.ytdlpDir} title={dbBackupDir}>
                      📁 {dbBackupDir || "(not loaded)"}
                    </span>
                    <span className={styles.ytdlpLabel} style={{ marginTop: 4 }}>
                      {dbBackups.length === 0 ? "No backups yet" : `${dbBackups.length} backup${dbBackups.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      className={styles.saveBtn}
                      onClick={handleBackupDb}
                      disabled={dbBusy !== null}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {dbBusy === "backup" ? "Backing up…" : "Backup now"}
                    </button>
                    <button
                      className={styles.saveBtn}
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={dbBusy !== null}
                      style={{ whiteSpace: "nowrap" }}
                      title="Upload a .db backup file from your computer"
                    >
                      {dbBusy === "upload" ? "Uploading…" : "Upload & Restore"}
                    </button>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      accept=".db"
                      style={{ display: "none" }}
                      onChange={handleUploadBackup}
                    />
                    <button
                      className={styles.saveBtn}
                      onClick={handleInitializeDb}
                      disabled={dbBusy !== null}
                      style={{ whiteSpace: "nowrap", background: "var(--color-error)" }}
                      title="Delete all downloads, subscriptions, seen videos, notifications. Keeps channels + settings."
                    >
                      {dbBusy === "init" ? "Initializing…" : "Initialize DB"}
                    </button>
                  </div>
                </div>
                {dbStatus && (
                  <p className={styles.ytdlpStatus} data-updated={!dbStatus.startsWith("✕")}>
                    {dbStatus}
                  </p>
                )}
                {dbBackups.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 6,
                    marginTop: 8, fontSize: "var(--text-xs)",
                  }}>
                    {dbBackups.slice(0, 10).map((b) => (
                      <div key={b.name} style={{
                        display: "flex", justifyContent: "space-between",
                        alignItems: "center", gap: 8,
                        padding: "6px 10px",
                        background: "var(--color-surface-hi)",
                        borderRadius: "var(--radius-sm)",
                      }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {b.name} · {(b.size / 1024).toFixed(1)} KB · {new Date(b.created_at).toLocaleString()}
                        </span>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <button
                            className={styles.saveBtn}
                            onClick={() => downloadDbBackup(b.name)}
                            style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
                            title="Download this backup to your computer"
                          >
                            Download
                          </button>
                          <button
                            className={styles.saveBtn}
                            onClick={() => handleRestoreDb(b.name)}
                            disabled={dbBusy !== null}
                            style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
                          >
                            Restore
                          </button>
                          <button
                            className={styles.saveBtn}
                            onClick={() => handleDeleteBackup(b.name)}
                            disabled={dbBusy !== null}
                            style={{
                              padding: "4px 10px",
                              fontSize: "var(--text-xs)",
                              background: "var(--color-error)",
                            }}
                            title="Delete this backup"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <SectionTitle>Raw Options</SectionTitle>
                <Field label="Raw YoutubeDL Options (JSON)" hint="Merged last — overrides all other settings. Must be a valid JSON object.">
                  <textarea
                    className={styles.textarea}
                    value={s.raw_options_json}
                    onChange={(e) => set("raw_options_json", e.target.value)}
                    rows={10}
                    placeholder={'{\n  "geo_bypass": true,\n  "quiet": false\n}'}
                    spellCheck={false}
                  />
                </Field>
              </div>
            )}

            {/* ── Notifications ── */}
            {activeTab === "Notifications" && (
              <div className={styles.fields}>

                <SectionTitle>Single downloads</SectionTitle>
                <Row>
                  <Toggle
                    label="Download started"
                    hint="One toast per download as it begins (off by default)"
                    checked={bool("notify_on_download_start")}
                    onChange={() => toggle("notify_on_download_start")}
                  />
                  <Toggle
                    label="Download completed"
                    checked={bool("notify_on_complete")}
                    onChange={() => toggle("notify_on_complete")}
                  />
                  <Toggle
                    label="Download failed"
                    checked={bool("notify_on_failed")}
                    onChange={() => toggle("notify_on_failed")}
                  />
                </Row>

                <SectionTitle>Subscriptions &amp; playlists</SectionTitle>
                <p className={styles.fieldHint} style={{ marginTop: 0 }}>
                  Per-video notifications for subscription downloads are always rolled up into a single
                  summary toast — these toggles control which summaries you see.
                </p>
                <Row>
                  <Toggle
                    label="Playlist download completed"
                    hint="One summary toast when a subscription's batch finishes"
                    checked={bool("notify_on_playlist_complete")}
                    onChange={() => toggle("notify_on_playlist_complete")}
                  />
                  <Toggle
                    label="New video detected"
                    hint="Fires when a subscription poll finds new videos"
                    checked={bool("notify_on_new_video")}
                    onChange={() => toggle("notify_on_new_video")}
                  />
                  <Toggle
                    label="Subscription check error"
                    checked={bool("notify_on_subscription_error")}
                    onChange={() => toggle("notify_on_subscription_error")}
                  />
                </Row>

                <SectionTitle>Summary</SectionTitle>
                <Row>
                  <Toggle label="Send periodic summary" checked={bool("notify_summary_enabled")} onChange={() => toggle("notify_summary_enabled")} />
                  <Field label="Interval (hours)">
                    <input className={styles.inputSm} type="number" min="1" value={s.notify_summary_interval_hours} onChange={(e) => set("notify_summary_interval_hours", e.target.value)} />
                  </Field>
                </Row>
                <button className={styles.presetBtn} onClick={handleSendSummary} disabled={summaryInProgress}>
                  {summaryInProgress ? "Sending…" : "Send summary now"}
                </button>

                <SectionTitle>Channels</SectionTitle>

                {/* Existing channels */}
                {channels.length === 0 && (
                  <p className={styles.fieldHint}>No channels configured. Add one below.</p>
                )}
                {channels.map((ch) => (
                  <ChannelCard
                    key={ch.id}
                    ch={ch}
                    onChange={(updated) =>
                      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
                    }
                    onDelete={() => handleDeleteChannel(ch.id)}
                  />
                ))}

                {/* Add channel form */}
                <div className={styles.addChannel}>
                  <select
                    className={styles.select}
                    value={addingKind}
                    onChange={(e) => {
                      setAddingKind(e.target.value as ChannelKind | "");
                      setAddingConfig({});
                      setAddingEvents([...DEFAULT_CHANNEL_EVENTS]);
                      setAddTestResult(null);
                    }}
                    style={{ maxWidth: 180 }}
                  >
                    <option value="">Add a channel…</option>
                    {CHANNEL_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>

                  {addingKind && (
                    <>
                      <Field label="Channel name">
                        <input className={styles.input} value={addingName} onChange={(e) => setAddingName(e.target.value)} placeholder="My Slack" />
                      </Field>
                      {CHANNEL_KINDS.find((k) => k.kind === addingKind)?.fields.map((f) => (
                        <Field key={f.key} label={f.label}>
                          <input
                            className={styles.input}
                            type={f.type ?? "text"}
                            placeholder={f.placeholder}
                            value={addingConfig[f.key] ?? ""}
                            onChange={(e) => setAddingConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
                          />
                        </Field>
                      ))}
                      <EventPicker value={addingEvents} onChange={setAddingEvents} />
                      <div className={styles.editorActions}>
                        <button className={styles.saveBtn} style={{ marginTop: 4 }} onClick={handleAddChannel} disabled={addingInProgress}>
                          {addingInProgress ? "Adding…" : "Add channel"}
                        </button>
                        <button className={styles.presetBtn} onClick={handleTestAddConfig} disabled={addTesting}>
                          {addTesting ? "Testing…" : "Test"}
                        </button>
                      </div>
                      {addTestResult && (
                        <TestLog result={addTestResult} onDismiss={() => setAddTestResult(null)} />
                      )}
                    </>
                  )}
                </div>

              </div>
            )}

          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.saveBtn}
            onClick={saved ? onClose : handleSave}
            disabled={saving}
          >
            {saved ? "Close" : saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      {hint && <p className={styles.fieldHint}>{hint}</p>}
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className={styles.sectionTitle}>{children}</p>;
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: () => void }) {
  return (
    <label className={styles.toggle}>
      <span className={styles.toggleTrack} data-checked={checked} onClick={onChange}>
        <span className={styles.toggleThumb} />
      </span>
      <span>
        <span className={styles.toggleLabel}>{label}</span>
        {hint && <span className={styles.fieldHint}>{hint}</span>}
      </span>
    </label>
  );
}

// ── Notification channel card (view / edit / test) ───────────────────────────

function parseConfig(raw: string | null): Record<string, string> {
  try {
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function eventSummary(events: ChannelEvent[]): string {
  if (events.length === 0) return "no events";
  if (events.length === CHANNEL_EVENTS.length) return "all events";
  const labels = CHANNEL_EVENTS.filter((e) => events.includes(e.event)).map((e) =>
    e.label.replace("Download ", "").replace("Playlist download completed", "playlist").toLowerCase(),
  );
  return labels.join(", ");
}

function EventPicker({
  value,
  onChange,
}: {
  value: ChannelEvent[];
  onChange: (next: ChannelEvent[]) => void;
}) {
  const toggle = (ev: ChannelEvent) =>
    onChange(value.includes(ev) ? value.filter((e) => e !== ev) : [...value, ev]);
  return (
    <div className={styles.eventPicker}>
      <span className={styles.fieldLabel}>Send to this channel</span>
      <div className={styles.eventGrid}>
        {CHANNEL_EVENTS.map((e) => (
          <label key={e.event} className={styles.eventItem}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={value.includes(e.event)}
              onChange={() => toggle(e.event)}
            />
            <span>{e.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function TestLog({ result, onDismiss }: { result: ChannelTestResult; onDismiss: () => void }) {
  const lines = [...result.logs];
  if (result.error && !result.ok) lines.push("", result.error);
  return (
    <div className={styles.testLog} data-ok={result.ok}>
      <div className={styles.testLogHead}>
        <span className={styles.testLogStatus}>
          {result.ok ? "✓ Test succeeded" : "✗ Test failed"}
        </span>
        <button className={styles.channelDelete} onClick={onDismiss} title="Dismiss">✕</button>
      </div>
      <pre className={styles.testLogBody}>{lines.join("\n") || "(no output)"}</pre>
    </div>
  );
}

function ChannelCard({
  ch,
  onChange,
  onDelete,
}: {
  ch: NotificationChannel;
  onChange: (c: NotificationChannel) => void;
  onDelete: () => void;
}) {
  const meta = CHANNEL_KINDS.find((k) => k.kind === ch.kind);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ch.name);
  const [config, setConfig] = useState<Record<string, string>>(() => parseConfig(ch.config_json));
  const [events, setEvents] = useState<ChannelEvent[]>(() => channelEvents(ch));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ChannelTestResult | null>(null);

  const resetEdits = () => {
    setName(ch.name);
    setConfig(parseConfig(ch.config_json));
    setEvents(channelEvents(ch));
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateChannel(ch.id, {
        name: name.trim() || ch.name,
        config_json: JSON.stringify(config),
        events_json: JSON.stringify(events),
      });
      onChange(updated);
      setEditing(false);
    } catch (e) {
      setResult({ ok: false, logs: [], error: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      // While editing, test the working (unsaved) config; otherwise the saved channel.
      setResult(editing ? await testChannelConfig(ch.kind, config) : await testChannel(ch.id));
    } catch (e) {
      setResult({
        ok: false,
        logs: [],
        error: e instanceof Error ? e.message : "Test request failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const toggleEnabled = async () => {
    try {
      onChange(await updateChannel(ch.id, { is_enabled: !ch.is_enabled }));
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className={styles.channelCard}>
      <div className={styles.channelRow}>
        <span className={styles.channelKind}>{meta?.label ?? ch.kind}</span>
        <span className={styles.channelName}>
          {ch.name}
          <span className={styles.channelEvents}>{eventSummary(channelEvents(ch))}</span>
        </span>
        <div className={styles.channelActions}>
          <button className={styles.presetBtn} onClick={runTest} disabled={testing}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button
            className={styles.presetBtn}
            onClick={() => {
              if (editing) resetEdits();
              setEditing((v) => !v);
            }}
          >
            {editing ? "Close" : "Edit"}
          </button>
          <label className={styles.toggle} style={{ marginBottom: 0 }}>
            <span className={styles.toggleTrack} data-checked={ch.is_enabled} onClick={toggleEnabled}>
              <span className={styles.toggleThumb} />
            </span>
          </label>
          <button className={styles.channelDelete} onClick={onDelete}>✕</button>
        </div>
      </div>

      {editing && (
        <div className={styles.channelEditor}>
          <Field label="Channel name">
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {meta?.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                className={styles.input}
                type={f.type ?? "text"}
                placeholder={f.placeholder}
                value={config[f.key] ?? ""}
                onChange={(e) => setConfig((p) => ({ ...p, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
          <EventPicker value={events} onChange={setEvents} />
          <div className={styles.editorActions}>
            <button className={styles.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              className={styles.presetBtn}
              onClick={() => {
                resetEdits();
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && <TestLog result={result} onDismiss={() => setResult(null)} />}
    </div>
  );
}

// ── Theme tab ────────────────────────────────────────────────────────────────

function ThemeTab() {
  const { mode, background, setMode, setBackground } = useTheme();
  const { statsMeter, setStatsMeter, resetSectionOrder } = useUiPrefs();
  const groups: Array<"Off" | "Vanta" | "Custom"> = ["Off", "Vanta", "Custom"];

  return (
    <div className={styles.fields}>
      <SectionTitle>Interface</SectionTitle>
      <Toggle
        label="Download activity meter"
        hint="Show the collapsible throughput graph above the download list"
        checked={statsMeter}
        onChange={() => setStatsMeter(!statsMeter)}
      />
      <Field
        label="Dashboard layout"
        hint="Reorder the Downloading / Completed / Subscriptions blocks with the ▲▼ buttons in each section header."
      >
        <button
          type="button"
          className={styles.presetBtn}
          onClick={resetSectionOrder}
          style={{ alignSelf: "flex-start" }}
        >
          Reset section order
        </button>
      </Field>

      <SectionTitle>Page mode</SectionTitle>
      <div className={styles.themeModeRow}>
        {(["dark", "light"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`${styles.themeModeBtn} ${mode === m ? styles.themeModeBtnActive : ""}`}
            onClick={() => setMode(m)}
          >
            <span className={styles.themeModeSwatch} data-mode={m} />
            <span>{m === "dark" ? "Dark" : "Light"}</span>
          </button>
        ))}
      </div>

      <SectionTitle>Background animation</SectionTitle>
      {groups.map((group) => {
        const items = BACKGROUND_OPTIONS.filter((o) => o.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className={styles.bgGroup}>
            <div className={styles.bgGroupLabel}>{group}</div>
            <div className={styles.bgGrid}>
              {items.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`${styles.bgTile} ${background === opt.id ? styles.bgTileActive : ""}`}
                  onClick={() => setBackground(opt.id)}
                >
                  <span className={styles.bgTilePreview} data-bg={opt.id} />
                  <span className={styles.bgTileLabel}>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
