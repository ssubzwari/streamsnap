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

# Install Python dependencies before copying source (better layer caching)
COPY backend/pyproject.toml ./
RUN pip install --no-cache-dir hatchling \
    && pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir -e .

# Copy backend source
COPY backend/app ./app

# Copy built frontend into the backend so FastAPI can serve it
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

# Persistent data directories
RUN mkdir -p /downloads /data

# Runtime environment
ENV DOWNLOAD_DIR=/downloads
ENV DB_URL=sqlite+aiosqlite:////data/metubeplus.db

EXPOSE 8000

CMD ["uvicorn", "app.main:socket_app", "--host", "0.0.0.0", "--port", "8000"]
