FROM node:22

WORKDIR /app

# Install global dev tools
RUN npm install -g nodemon

COPY package.json package-lock.json ./

COPY packages ./packages
COPY apps ./apps

RUN npm install

WORKDIR /app/apps/websocket-service

CMD ["nodemon", "src/index.js"]