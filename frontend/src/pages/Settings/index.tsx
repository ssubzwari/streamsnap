import { useEffect, useState } from "react";
import {
  backupDb,
  getSettings,
  getYtdlpVersion,
  initializeDb,
  listDbBackups,
  restoreDb,
  updateSettings,
  updateYtdlp,
  type DbBackupEntry,
  type YtdlpVersionInfo,
} from "@/api/settings";
import {
  type ChannelKind,
  type NotificationChannel,
  createChannel,
  deleteChannel,
  listChannels,
  sendSummaryNow,
  testChannel,
  updateChannel,
} from "@/api/notifications";
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
  write_info_json: string;
  write_description: string;
  embed_metadata: string;
  embed_chapters: string;
  // Post-processing
  sponsorblock_remove: string;
  ffmpeg_location: string;
  keep_video: string;
  // Download
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
  notify_on_complete: string;
  notify_on_failed: string;
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
  write_info_json: "false",
  write_description: "false",
  embed_metadata: "false",
  embed_chapters: "false",
  sponsorblock_remove: "",
  ffmpeg_location: "",
  keep_video: "false",
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
  notify_on_complete: "true",
  notify_on_failed: "true",
  notify_on_new_video: "true",
  notify_on_subscription_error: "true",
  notify_summary_enabled: "false",
  notify_summary_interval_hours: "24",
};

const TABS = [
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
  const [addingInProgress, setAddingInProgress] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [summaryInProgress, setSummaryInProgress] = useState(false);

  // ── yt-dlp updater state ──────────────────────────────────────────────────
  const [ytdlpInfo, setYtdlpInfo] = useState<YtdlpVersionInfo | null>(null);
  const [ytdlpUpdating, setYtdlpUpdating] = useState(false);
  const [ytdlpResult, setYtdlpResult] = useState<{ updated: boolean; new_version: string } | null>(null);
  const [ytdlpError, setYtdlpError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(({ settings }) => {
      setS((prev) => ({ ...prev, ...Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== null)
      ) as Partial<SettingsState> }));
    }).catch(console.error);
    listChannels().then(setChannels).catch(console.error);
    getYtdlpVersion().then(setYtdlpInfo).catch(console.error);
  }, []);

  const set = (key: keyof SettingsState, value: string) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const toggle = (key: keyof SettingsState) =>
    setS((prev) => ({ ...prev, [key]: prev[key] === "true" ? "false" : "true" }));

  const handleAddChannel = async () => {
    if (!addingKind || !addingName.trim()) return;
    setAddingInProgress(true);
    try {
      const ch = await createChannel({
        kind: addingKind,
        name: addingName.trim(),
        config_json: JSON.stringify(addingConfig),
      });
      setChannels((prev) => [...prev, ch]);
      setAddingKind("");
      setAddingName("");
      setAddingConfig({});
    } catch (e) { console.error(e); }
    finally { setAddingInProgress(false); }
  };

  const handleToggleChannel = async (ch: NotificationChannel) => {
    try {
      const updated = await updateChannel(ch.id, { is_enabled: !ch.is_enabled });
      setChannels((prev) => prev.map((c) => c.id === ch.id ? updated : c));
    } catch (e) { console.error(e); }
  };

  const handleDeleteChannel = async (id: number) => {
    try {
      await deleteChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch (e) { console.error(e); }
  };

  const handleTestChannel = async (id: number) => {
    setTestingId(id);
    try { await testChannel(id); }
    catch (e) { console.error(e); }
    finally { setTestingId(null); }
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

  useEffect(() => { refreshDbBackups(); }, []);

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
      setDbStatus(`✓ Restored from ${name}. Reload the page to see the restored data.`);
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Restore failed"}`);
    } finally {
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
      setDbStatus(`✓ Cleared: ${parts}. Reload to refresh the UI.`);
    } catch (e) {
      setDbStatus(`✕ ${e instanceof Error ? e.message : "Initialize failed"}`);
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
      setTimeout(() => setSaved(false), 2000);
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
              </div>
            )}

            {/* ── Download ── */}
            {activeTab === "Download" && (
              <div className={styles.fields}>
                <Row>
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
                        <button
                          className={styles.saveBtn}
                          onClick={() => handleRestoreDb(b.name)}
                          disabled={dbBusy !== null}
                          style={{ padding: "4px 10px", fontSize: "var(--text-xs)" }}
                        >
                          Restore
                        </button>
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

                <SectionTitle>Event Suppression</SectionTitle>
                <Row>
                  <Toggle label="Download completed" checked={bool("notify_on_complete")} onChange={() => toggle("notify_on_complete")} />
                  <Toggle label="Download failed" checked={bool("notify_on_failed")} onChange={() => toggle("notify_on_failed")} />
                </Row>
                <Row>
                  <Toggle label="New video from subscription" checked={bool("notify_on_new_video")} onChange={() => toggle("notify_on_new_video")} />
                  <Toggle label="Subscription check error" checked={bool("notify_on_subscription_error")} onChange={() => toggle("notify_on_subscription_error")} />
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
                {channels.map((ch) => {
                  const meta = CHANNEL_KINDS.find((k) => k.kind === ch.kind);
                  return (
                    <div key={ch.id} className={styles.channelRow}>
                      <span className={styles.channelKind}>{meta?.label ?? ch.kind}</span>
                      <span className={styles.channelName}>{ch.name}</span>
                      <div className={styles.channelActions}>
                        <button
                          className={styles.presetBtn}
                          onClick={() => handleTestChannel(ch.id)}
                          disabled={testingId === ch.id}
                        >
                          {testingId === ch.id ? "Testing…" : "Test"}
                        </button>
                        <label className={styles.toggle} style={{ marginBottom: 0 }}>
                          <span className={styles.toggleTrack} data-checked={ch.is_enabled} onClick={() => handleToggleChannel(ch)}>
                            <span className={styles.toggleThumb} />
                          </span>
                        </label>
                        <button className={styles.channelDelete} onClick={() => handleDeleteChannel(ch.id)}>✕</button>
                      </div>
                    </div>
                  );
                })}

                {/* Add channel form */}
                <div className={styles.addChannel}>
                  <select
                    className={styles.select}
                    value={addingKind}
                    onChange={(e) => { setAddingKind(e.target.value as ChannelKind | ""); setAddingConfig({}); }}
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
                      <button className={styles.saveBtn} style={{ marginTop: 4 }} onClick={handleAddChannel} disabled={addingInProgress}>
                        {addingInProgress ? "Adding…" : "Add channel"}
                      </button>
                    </>
                  )}
                </div>

              </div>
            )}

          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saved ? "Saved!" : saving ? "Saving…" : "Save Settings"}
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
