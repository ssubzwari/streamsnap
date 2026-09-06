from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "StreamSnap"
    DEBUG: bool = False
    DB_URL: str = "sqlite+aiosqlite:///./streamsnap.db"
    DOWNLOAD_DIR: str = "./downloads"
    # Fallback only — the live value comes from the `max_concurrent_downloads`
    # setting (Settings → Download), which defaults to 1 when unset.
    MAX_CONCURRENT_DOWNLOADS: int = 1

    # Directory where yt-dlp is installed as an isolated Python package.
    # Empty string = use the system/venv-installed yt-dlp (local dev default).
    # In Docker this is set to /ytdlp (a named volume) so updates persist.
    YTDLP_DIR: str = ""

    # Origins allowed to open a Socket.IO / REST cross-origin connection.
    # Empty (default) = allow any origin, which is fine for the intended
    # single-user, private-network deployment. Set a comma-separated list
    # (e.g. "http://localhost:5173,http://nas.local:8088") to restrict it when
    # the instance is reachable from an untrusted network.
    CORS_ORIGINS: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
