from dataclasses import dataclass

# Event name constants
DOWNLOAD_ADDED = "download:added"
DOWNLOAD_UPDATED = "download:updated"
DOWNLOAD_COMPLETED = "download:completed"
DOWNLOAD_FAILED = "download:failed"
DOWNLOAD_CANCELED = "download:canceled"

DOWNLOADS_PAUSED = "downloads:paused"

SUBSCRIPTION_CHECKED = "subscription:checked"
SUBSCRIPTION_NEW_VIDEO = "subscription:new_video"
NOTIFICATION_CREATED = "notification:created"


@dataclass
class DownloadUpdatedPayload:
    id: int
    percent: float
    speed: str | None
    eta: int | None
    status: str


@dataclass
class DownloadFailedPayload:
    id: int
    error: str


@dataclass
class DownloadCanceledPayload:
    id: int


@dataclass
class SubscriptionCheckedPayload:
    id: int
    new_count: int
    last_checked_at: str  # ISO format


@dataclass
class SubscriptionNewVideoPayload:
    subscription_id: int
    video_id: str
    title: str | None


@dataclass
class NotificationCreatedPayload:
    id: int
    kind: str
    title: str
    body: str | None
