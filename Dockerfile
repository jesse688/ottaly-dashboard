FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates xvfb x11vnc fluxbox novnc websockify \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# email-finder-local deps (socks package)
COPY apps/admin-legacy/email-finder-local/package*.json ./email-finder-local/
RUN cd email-finder-local && npm install --omit=dev

# main server deps
COPY apps/admin-legacy/package*.json ./
RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

# copy all admin-legacy files (server.js, email-finder-local/, public/, etc.)
COPY apps/admin-legacy/ ./

EXPOSE 3000 6080
CMD ["node", "server.js"]
