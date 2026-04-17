from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict


class DownloadStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    completed = "completed"
    failed = "failed"
    canceled = "canceled"


class FormatInfo(BaseModel):
    format_id: str
    ext: str
    quality: str
    filesize: int | None = None


class MetadataResolveRequest(BaseModel):
    url: str


class MetadataResolveResponse(BaseModel):
    url: str
    title: str
    thumbnail: str | None = None
    duration: int | None = None
    formats: list[FormatInfo]


class DownloadCreateRequest(BaseModel):
    url: str
    format_spec: str = "best"
    title: str | None = None
    thumbnail: str | None = None
    duration: int | None = None


class DownloadInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    title: str | None = None
    thumbnail: str | None = None
    duration: int | None = None
    status: DownloadStatus
    percent: float
    speed: str | None = None
    eta: int | None = None
    format_spec: str | None = None
    output_path: str | None = None
    error_message: str | None = None
    subscription_id: int | None = None
    ext: str | None = None
    filesize: int | None = None
    height: int | None = None
    vcodec: str | None = None
    acodec: str | None = None
    created_at: datetime
    updated_at: datetime


class DownloadProgressEvent(BaseModel):
    id: int
    percent: float
    speed: str | None = None
    eta: int | None = None
    status: DownloadStatus


# ── Subscription schemas ──────────────────────────────────────────────────────

class SubscriptionCreate(BaseModel):
    url: str
    check_interval_minutes: int = 60
    format_spec: str = "bestvideo*+bestaudio/best"
    output_template: str | None = None
    download_existing: bool = False
    notify: bool = True


class SubscriptionUpdate(BaseModel):
    check_interval_minutes: int | None = None
    format_spec: str | None = None
    output_template: str | None = None
    is_active: bool | None = None
    notify: bool | None = None


class SubscriptionInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    title: str | None = None
    check_interval_minutes: int
    last_checked_at: datetime | None = None
    format_spec: str | None = None
    output_template: str | None = None
    is_active: bool
    download_existing: bool
    download_dir: str | None = None
    notify: bool = True
    created_at: datetime


# ── Notification schemas ──────────────────────────────────────────────────────

class NotificationInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str | None = None
    payload_json: str | None = None
    is_read: bool
    created_at: datetime


# ── Notification channel schemas ─────────────────────────────────────────────

class NotificationChannelCreate(BaseModel):
    kind: str
    name: str
    config_json: str | None = None
    is_enabled: bool = True


class NotificationChannelUpdate(BaseModel):
    name: str | None = None
    config_json: str | None = None
    is_enabled: bool | None = None


class NotificationChannelInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    name: str
    config_json: str | None = None
    is_enabled: bool
    created_at: datetime


# ── Settings schemas ──────────────────────────────────────────────────────────

class SettingItem(BaseModel):
    key: str
    value: str | None = None


class SettingsMap(BaseModel):
    settings: dict[str, str | None]
