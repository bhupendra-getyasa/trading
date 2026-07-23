FROM node:22-slim

WORKDIR /app

# 1. Copy ROOT workspace files FIRST
COPY package.json package-lock.json ./

# 2. Copy ALL workspace definitions this service needs
COPY apps/agent-service ./apps/agent-service
COPY packages/shared ./packages/shared

# 3. Install only production deps
RUN npm ci --omit=dev

# 4. Move into service
WORKDIR /app/apps/agent-service

CMD ["node", "src/index.js"]
