FROM node:22

WORKDIR /app

# Install global dev tools
RUN npm install -g nodemon

# 1. Copy ROOT workspace files FIRST
COPY package.json package-lock.json ./

# 2. Copy ALL workspace definitions
COPY packages ./packages
COPY apps ./apps

# 3. Install dependencies at ROOT (IMPORTANT)
RUN npm install

# Install Playwright browsers + Linux deps
RUN npx playwright install --with-deps chromium

# 4. Move into service
WORKDIR /app/apps/ingestion-service

CMD ["nodemon", "src/index.js"]