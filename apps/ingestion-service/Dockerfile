FROM node:22-slim

WORKDIR /app

# Xvfb = virtual display for headed Chromium (the awsat login stalls headless).
# x11-utils gives xdpyinfo (readiness check); dbus quiets Chromium's warning.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11-utils dbus dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# 1. Copy ROOT workspace files FIRST
COPY package.json package-lock.json ./

# 2. Copy ALL workspace definitions
COPY apps/ingestion-service ./apps/ingestion-service
COPY apps/agent-service/package.json apps/agent-service/
COPY packages/shared ./packages/shared

# 3. Install only production deps
RUN npm ci --omit=dev

# Install Playwright browsers + Linux deps
RUN npx playwright install --with-deps chromium

# Entrypoint (copied to /usr/local/bin so it's outside any bind mount)
COPY apps/ingestion-service/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 4. Move into service
WORKDIR /app/apps/ingestion-service

# Entrypoint starts Xvfb, exports DISPLAY, then exec's the CMD (so node stays
# PID 1 and receives SIGTERM for graceful closeScraper()).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]