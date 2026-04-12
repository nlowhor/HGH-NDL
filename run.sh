#!/usr/bin/env bash
# Local launcher for the ER staff display. Starts a static HTTP
# server in this directory and opens the page in your browser.
# Usage:  ./run.sh           (defaults to port 8000)
#         PORT=9001 ./run.sh (override port)

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# If the requested port is taken, try the next few.
is_listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    # Fallback: attempt a TCP connect via bash
    (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

tries=0
while is_listening "$PORT"; do
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    echo "Could not find a free port near $PORT." >&2
    exit 1
  fi
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT"
echo "Serving ER staff display at $URL  (Ctrl+C to stop)"

# Open the browser after the server has a moment to come up.
(
  sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v wslview >/dev/null 2>&1; then wslview "$URL"
  fi
) &

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT"
else
  echo "Python 3 not found. Install Python or run: npx --yes serve -l $PORT ." >&2
  exit 1
fi
