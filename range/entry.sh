#!/bin/sh
# One challenge per container: write the flag, then serve $BIN on $PORT.
set -e

if [ -n "$FLAG" ]; then
  printf '%s\n' "$FLAG" > /flag
  chmod 0644 /flag
fi

if [ ! -x "$BIN" ]; then
  echo "BIN not executable: $BIN" >&2
  exit 1
fi

# pty keeps the binary's stdio line-buffered, which is what a real pwn service
# does; without it a prompt printed with printf() and no newline is withheld.
exec socat -d -d "TCP-LISTEN:${PORT},reuseaddr,fork" "EXEC:${BIN},${SOCAT_OPTS}"
