FROM node:22-slim

WORKDIR /app

# 1. Copy ROOT workspace files FIRST
COPY package.json package-lock.json ./

# 2. Copy ALL workspace definitions
COPY apps/ingestion-service ./apps/ingestion-service
COPY packages/shared ./packages/shared

# 3. Install dependencies at ROOT (IMPORTANT)
# RUN npm install --production

# Install only production deps
RUN npm ci --omit=dev

# Install Playwright browsers + Linux deps
RUN npx playwright install --with-deps chromium

# 4. Move into service
WORKDIR /app/apps/ingestion-service

CMD ["node", "--max-old-space-size=512", "src/index.js"]