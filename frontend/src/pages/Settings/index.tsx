import { useEffect, useState } from "react";
import { getSettings, updateSettings } from "@/api/settings";
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
] as const;

type Tab = typeof TABS[number];

interface Props {
  onClose: () => void;
}

export default function Settings({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Format");
  const [s, setS] = useState<SettingsState>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(({ settings }) => {
      setS((prev) => ({ ...prev, ...Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== null)
      ) as Partial<SettingsState> }));
    }).catch(console.error);
  }, []);

  const set = (key: keyof SettingsState, value: string) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const toggle = (key: keyof SettingsState) =>
    setS((prev) => ({ ...prev, [key]: prev[key] === "true" ? "false" : "true" }));

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
                <Field label="Raw YoutubeDL Options (JSON)" hint="Merged last — overrides all other settings. Must be a valid JSON object.">
                  <textarea
                    className={styles.textarea}
                    value={s.raw_options_json}
                    onChange={(e) => set("raw_options_json", e.target.value)}
                    rows={12}
                    placeholder={'{\n  "geo_bypass": true,\n  "quiet": false\n}'}
                    spellCheck={false}
                  />
                </Field>
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
