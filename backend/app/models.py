from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Download(Base):
    __tablename__ = "downloads"

    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    thumbnail: Mapped[str | None] = mapped_column(String)
    duration: Mapped[int | None]
    status: Mapped[str] = mapped_column(String, default="queued")  # queued|downloading|completed|failed|canceled
    percent: Mapped[float] = mapped_column(default=0.0)
    speed: Mapped[str | None] = mapped_column(String)
    eta: Mapped[int | None]
    format_spec: Mapped[str | None] = mapped_column(String)
    output_path: Mapped[str | None] = mapped_column(String)
    error_message: Mapped[str | None] = mapped_column(String)
    subscription_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("subscriptions.id"), nullable=True)
    # Format info populated on completion
    ext: Mapped[str | None] = mapped_column(String)
    filesize: Mapped[int | None]
    height: Mapped[int | None]
    vcodec: Mapped[str | None] = mapped_column(String)
    acodec: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    check_interval_minutes: Mapped[int] = mapped_column(Integer, default=60)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    format_spec: Mapped[str | None] = mapped_column(String, default="bestvideo*+bestaudio/best")
    output_template: Mapped[str | None] = mapped_column(String)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    download_existing: Mapped[bool] = mapped_column(Boolean, default=False)
    download_dir: Mapped[str | None] = mapped_column(String, nullable=True)
    # When False, new_video / subscription_error notifications for this sub
    # are suppressed (downloads still happen, they just don't alert).
    notify: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SeenVideo(Base):
    __tablename__ = "seen_videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(ForeignKey("subscriptions.id"))
    video_id: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    upload_date: Mapped[str | None] = mapped_column(String)
    detected_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("subscription_id", "video_id"),)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String)
    title: Mapped[str] = mapped_column(String)
    body: Mapped[str | None] = mapped_column(String)
    thumbnail: Mapped[str | None] = mapped_column(String)
    payload_json: Mapped[str | None] = mapped_column(String)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str | None] = mapped_column(String)


class NotificationChannel(Base):
    __tablename__ = "notification_channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String)   # smtp|slack|discord|telegram|pushover
    name: Mapped[str] = mapped_column(String)   # user label
    config_json: Mapped[str | None] = mapped_column(String)  # JSON blob
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
