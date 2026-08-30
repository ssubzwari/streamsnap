# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM python:3.12-slim

# Install ffmpeg (required for 1080p+ merging)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python backend dependencies (everything except yt-dlp)
COPY backend/pyproject.toml ./
RUN pip install --no-cache-dir hatchling \
    && pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir -e .

# Copy backend source
COPY backend/app ./app

# Copy built frontend into the backend so FastAPI can serve it
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

# ── yt-dlp isolated install ───────────────────────────────────────────────────
# yt-dlp lives in /ytdlp — a dedicated Docker volume — so that updates via
# Settings → "Update to latest" persist across container restarts without
# rebuilding the image, separate from the /downloads and /data volumes.
#
# The volume is empty on first run and masks anything baked into /ytdlp at build
# time, so we stage a copy in /opt/ytdlp-seed and the entrypoint copies it into
# /ytdlp when the volume has no yt-dlp yet. A user-initiated update overwrites it.
RUN mkdir -p /opt/ytdlp-seed /ytdlp /downloads /data \
    && pip install --no-cache-dir --target /opt/ytdlp-seed yt-dlp

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Runtime environment
ENV DOWNLOAD_DIR=/downloads
ENV DB_URL=sqlite+aiosqlite:////data/metubeplus.db
ENV YTDLP_DIR=/ytdlp
ENV YTDLP_SEED_DIR=/opt/ytdlp-seed

EXPOSE 8088

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:socket_app", "--host", "0.0.0.0", "--port", "8088"]
