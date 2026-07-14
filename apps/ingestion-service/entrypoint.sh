#!/usr/bin/env bash
# entrypoint.sh — provide a virtual X display for headed Chromium, then run the app.
# `exec "$@"` keeps node as the main process so it still receives SIGTERM/SIGINT
# (needed for the graceful closeScraper() shutdown).
set -e

export DISPLAY=:99
rm -f /tmp/.X99-lock 2>/dev/null || true

# Start the virtual framebuffer.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

# Wait until the display is actually up (max ~5s).
for _ in $(seq 1 25); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# (Optional) silence the dbus warning Chromium prints in containers.
if command -v dbus-daemon >/dev/null 2>&1; then
  mkdir -p /run/dbus
  dbus-daemon --system --fork 2>/dev/null || true
fi

# Clean up Xvfb when the app exits.
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT

exec "$@"