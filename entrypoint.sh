#!/usr/bin/env sh
# Serve web/ locally: ./entrypoint.sh [PORT]  (default 8080)
set -eu
cd "$(dirname "$0")"
exec python3 -m http.server "${1:-8080}" --directory web
