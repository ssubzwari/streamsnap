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
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None


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
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None
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

class PlaylistEntry(BaseModel):
    id: str
    url: str
    title: str | None = None
    upload_date: str | None = None


class SubscriptionCreate(BaseModel):
    url: str
    check_interval_minutes: int = 60
    format_spec: str = "bestvideo*+bestaudio/best"
    output_template: str | None = None
    download_existing: bool = False
    notify: bool = True
    # When download_existing is true, restrict the initial backfill downloads
    # to these video ids. None → download every existing video (default).
    # Every current video is still recorded in seen_videos regardless, so
    # removed ones are simply not re-downloaded later as "new".
    download_video_ids: list[str] | None = None
    # Optional: the playlist title + full entry list already fetched by the
    # client's review step. When provided the server skips re-extracting the
    # playlist (which can exceed the reverse-proxy timeout for big channels).
    playlist_title: str | None = None
    entries: list[PlaylistEntry] | None = None
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None


class SubscriptionUpdate(BaseModel):
    check_interval_minutes: int | None = None
    format_spec: str | None = None
    output_template: str | None = None
    is_active: bool | None = None
    notify: bool | None = None
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None


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
    category: str | None = None
    subcategory: str | None = None
    tag: str | None = None
    created_at: datetime


class CategoryTreeNode(BaseModel):
    """A single category with its children. Used for autocomplete UI."""
    name: str
    subcategories: dict[str, list[str]]  # subcat name → list of tags


class CategoryTree(BaseModel):
    categories: dict[str, dict[str, list[str]]]  # category → subcat → tags


# ── Notification schemas ──────────────────────────────────────────────────────

class NotificationInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str | None = None
    thumbnail: str | None = None
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


class ChannelTestRequest(BaseModel):
    """Test an unsaved channel config (used by the add/edit form)."""
    kind: str
    config_json: str | None = None


class ChannelTestResult(BaseModel):
    ok: bool
    logs: list[str]
    error: str | None = None


# ── Settings schemas ──────────────────────────────────────────────────────────

class SettingItem(BaseModel):
    key: str
    value: str | None = None


class SettingsMap(BaseModel):
    settings: dict[str, str | None]
