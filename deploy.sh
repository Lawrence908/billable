#!/usr/bin/env bash
# Build and (re)start billable. Use this rather than a bare `docker compose up`:
# it bakes the build time and the cache-busting asset version into the image,
# and handles the sync switch.
#
#   ./deploy.sh                    # default: no sync. No API container, and the
#                                  # page may make no network requests at all.
#   ENABLE_SYNC=true ./deploy.sh   # with end-to-end encrypted sync
set -Eeuo pipefail
cd "$(dirname "$0")"
export ENABLE_SYNC="${ENABLE_SYNC:-false}"
export APP_UID="$(id -u)" APP_GID="$(id -g)"
export BUILD_TIME="$(date -u '+%Y-%m-%d %H:%M UTC')"
export BUILD_ID="$(date +%s)"
if [ "$ENABLE_SYNC" = "true" ]; then
  mkdir -p data/mailboxes   # created as the user the API container runs as
  docker compose --profile sync up -d --build
else
  # Stop and remove the API container if an earlier sync build left it running.
  docker compose rm --stop --force billable-api >/dev/null 2>&1 || true
  docker compose up -d --build
fi
echo "deployed billable @ $BUILD_TIME (sync: $ENABLE_SYNC)"
