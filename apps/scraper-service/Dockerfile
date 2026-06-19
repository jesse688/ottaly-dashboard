# Cheerio-based scraper — no browser needed, so a slim Node image is enough.
FROM node:20-slim

# Crawlee's autoscaler shells out to `ps` (from procps) for memory snapshots;
# the slim image omits it, which crashes jobs with "spawn ps ENOENT".
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Crawlee writes temp storage; keep it inside the container and ephemeral.
ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee

CMD ["node", "index.js"]
