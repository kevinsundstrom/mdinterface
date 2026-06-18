#!/usr/bin/env bash
# mdinterface launcher — stop any running instance, start fresh in the background, print the URL.
# Usage:  ./start.sh [path/to/doc.md]              (defaults to this repo's README.md)
#         MDINTERFACE_PORT=8000 ./start.sh ~/notes/draft.md
DIR="$(cd "$(dirname "$0")" && pwd)"
DOC="${1:-$DIR/README.md}"
PORT="${MDINTERFACE_PORT:-7777}"
LOG="${TMPDIR:-/tmp}/mdinterface.log"

# Stop only OUR server on this port — match the server.js command rather than killing
# whatever happens to be listening — then wait for the port to free (avoids EADDRINUSE).
for pid in $(lsof -ti :"$PORT" 2>/dev/null || true); do
  if ps -p "$pid" -o command= 2>/dev/null | grep -q "server.js"; then kill "$pid" 2>/dev/null || true; fi
done
for _ in $(seq 1 20); do lsof -ti :"$PORT" >/dev/null 2>&1 || break; sleep 0.1; done

# Launch detached so it keeps running after this script (and your shell) returns.
nohup node "$DIR/server.js" "$DOC" --port "$PORT" > "$LOG" 2>&1 &

# Wait for the startup line, then surface the tokenized URL.
for _ in $(seq 1 50); do grep -q "http://localhost" "$LOG" 2>/dev/null && break; sleep 0.2; done
URL="$(grep -o 'http://localhost[^ ]*' "$LOG" | tail -1)"
echo
if [ -n "$URL" ]; then
  echo "  mdinterface ▸ running ▸ $URL"
  echo "  logs: $LOG   ·   stop: lsof -ti :$PORT | xargs kill"
else
  echo "  mdinterface did not start cleanly — last lines of $LOG:"
  tail -5 "$LOG" 2>/dev/null
fi
echo
