#!/usr/bin/env bash
# Build and (re)start billable. Use this rather than a bare `docker compose up`:
# it bakes the build time and the cache-busting asset version into the image,
# and creates the data directory as the user the API container runs as.
set -Eeuo pipefail
cd "$(dirname "$0")"
export APP_UID="$(id -u)" APP_GID="$(id -g)"
mkdir -p data/mailboxes
export BUILD_TIME="$(date -u '+%Y-%m-%d %H:%M UTC')"
export BUILD_ID="$(date +%s)"
docker compose up -d --build
echo "deployed billable @ $BUILD_TIME"
