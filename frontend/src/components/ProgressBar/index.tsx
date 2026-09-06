import type { DownloadStatus } from "@/ws/events";
import styles from "./ProgressBar.module.css";

interface ProgressBarProps {
  percent: number;
  status: DownloadStatus;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "var(--color-success)",
  failed: "var(--color-error)",
  canceled: "var(--color-text-muted)",
};

export default function ProgressBar({ percent, status }: ProgressBarProps) {
  const color = STATUS_COLORS[status] ?? "var(--color-accent)";

  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={styles.fill}
        style={{
          width: `${Math.min(Math.max(percent, 0), 100)}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}
