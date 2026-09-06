#!/bin/sh
set -e

# Seed the isolated yt-dlp dir (a named volume, empty on first run) from the
# copy baked into the image, so the app always has a working yt-dlp and the
# reported version reflects what's actually on disk. A user-initiated
# "Update to latest" replaces these files in place and persists in the volume.
YTDLP_DIR="${YTDLP_DIR:-/ytdlp}"
YTDLP_SEED_DIR="${YTDLP_SEED_DIR:-/opt/ytdlp-seed}"

mkdir -p "$YTDLP_DIR"
if [ ! -d "$YTDLP_DIR/yt_dlp" ] && [ -d "$YTDLP_SEED_DIR/yt_dlp" ]; then
    echo "[entrypoint] seeding $YTDLP_DIR from $YTDLP_SEED_DIR"
    cp -a "$YTDLP_SEED_DIR/." "$YTDLP_DIR/"
fi

exec "$@"
