import ProgressBar from "@/components/ProgressBar";
import type { DownloadInfo } from "@/ws/events";
import styles from "./DownloadRow.module.css";

interface DownloadRowProps {
  download: DownloadInfo;
  onDelete: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function DownloadRow({ download, onDelete }: DownloadRowProps) {
  const isActive =
    download.status === "queued" || download.status === "downloading";

  return (
    <div className={styles.row}>
      {download.thumbnail && (
        <img
          className={styles.thumb}
          src={download.thumbnail}
          alt=""
          loading="lazy"
        />
      )}

      <div className={styles.body}>
        <div className={styles.titleRow}>
          <span className={styles.title} title={download.title ?? download.url}>
            {download.title ?? download.url}
          </span>
          <span className={`${styles.badge} ${styles[download.status]}`}>
            {STATUS_LABELS[download.status] ?? download.status}
          </span>
        </div>

        {isActive && (
          <>
            <ProgressBar percent={download.percent} status={download.status} />
            <div className={styles.meta}>
              <span>{download.percent.toFixed(1)}%</span>
              {download.speed && <span>{download.speed}</span>}
              {download.eta != null && <span>ETA {download.eta}s</span>}
              {download.duration && (
                <span>{formatDuration(download.duration)}</span>
              )}
            </div>
          </>
        )}

        {download.status === "completed" && (
          <ProgressBar percent={100} status="completed" />
        )}

        {download.status === "failed" && download.error_message && (
          <p className={styles.error}>{download.error_message}</p>
        )}

        {download.status === "completed" && download.output_path && (
          <p className={styles.outputPath} title={download.output_path}>
            {download.output_path}
          </p>
        )}
      </div>

      <button
        className={styles.deleteBtn}
        onClick={onDelete}
        title={isActive ? "Cancel" : "Remove"}
        aria-label={isActive ? "Cancel download" : "Remove download"}
      >
        {isActive ? "Cancel" : "✕"}
      </button>
    </div>
  );
}
