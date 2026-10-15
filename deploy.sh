#!/usr/bin/env bash
# Rebuild and redeploy billable, baking the build time into the page footer.
set -Eeuo pipefail
cd "$(dirname "$0")"
export BUILD_TIME="$(date -u '+%Y-%m-%d %H:%M UTC')"
export BUILD_ID="$(date +%s)"
docker compose up -d --build
echo "deployed billable @ $BUILD_TIME"
