FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

COPY apps/websocket-service ./apps/websocket-service
COPY packages/shared ./packages/shared

RUN npm install --production

WORKDIR /app/apps/websocket-service

CMD ["node", "src/index.js"]