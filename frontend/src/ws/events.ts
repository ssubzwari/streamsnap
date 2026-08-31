export type DownloadStatus =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "canceled";

export interface DownloadInfo {
  id: number;
  url: string;
  title: string | null;
  thumbnail: string | null;
  duration: number | null;
  status: DownloadStatus;
  percent: number;
  speed: string | null;
  eta: number | null;
  format_spec: string | null;
  output_path: string | null;
  error_message: string | null;
  subscription_id: number | null;
  ext: string | null;
  filesize: number | null;
  height: number | null;
  vcodec: string | null;
  acodec: string | null;
  created_at: string;
  updated_at: string;
}

export interface DownloadUpdatedPayload {
  id: number;
  percent: number;
  speed: string | null;
  eta: number | null;
  status: DownloadStatus;
}

export interface DownloadFailedPayload {
  id: number;
  error: string;
}

export interface DownloadCanceledPayload {
  id: number;
}

export interface DownloadsPausedPayload {
  paused: boolean;
  reason: string | null;
}

export interface SubscriptionInfo {
  id: number;
  url: string;
  title: string | null;
  check_interval_minutes: number;
  last_checked_at: string | null;
  format_spec: string | null;
  output_template: string | null;
  is_active: boolean;
  download_existing: boolean;
  download_dir?: string | null;
  notify: boolean;
  created_at: string;
}

export interface SubscriptionCheckedPayload {
  id: number;
  new_count: number;
  last_checked_at: string;
}

export interface SubscriptionNewVideoPayload {
  subscription_id: number;
  video_id: string;
  title: string | null;
}

export interface NotificationInfo {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  payload_json: string | null;
  is_read: boolean;
  created_at: string;
}

export const WS_EVENTS = {
  DOWNLOAD_ADDED: "download:added",
  DOWNLOAD_UPDATED: "download:updated",
  DOWNLOAD_COMPLETED: "download:completed",
  DOWNLOAD_FAILED: "download:failed",
  DOWNLOAD_CANCELED: "download:canceled",
  DOWNLOADS_PAUSED: "downloads:paused",
  SUBSCRIPTION_CHECKED: "subscription:checked",
  SUBSCRIPTION_NEW_VIDEO: "subscription:new_video",
  NOTIFICATION_CREATED: "notification:created",
} as const;
