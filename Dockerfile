FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates xvfb x11vnc fluxbox novnc websockify \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium
COPY . .
EXPOSE 3000 6080
CMD ["node", "server.js"]
