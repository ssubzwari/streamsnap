from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "MetubePlus"
    DEBUG: bool = False
    DB_URL: str = "sqlite+aiosqlite:///./metubeplus.db"
    DOWNLOAD_DIR: str = "./downloads"
    MAX_CONCURRENT_DOWNLOADS: int = 3


settings = Settings()
