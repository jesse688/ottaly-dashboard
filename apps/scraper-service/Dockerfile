# Crawlee's own base image for CheerioCrawler (no browser, Alpine, includes the
# system tools Crawlee expects). Recommended by https://crawlee.dev for Cheerio.
FROM apify/actor-node:20

# Alpine ships `ps` via busybox, but install procps so Crawlee's memory snapshot
# (which may shell out to `ps`) always finds a full implementation.
USER root
RUN apk add --no-cache procps || true

WORKDIR /app

# Copy manifests and install prod deps. (--omit=dev keeps the image lean.)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-optional

COPY . .

# Crawlee writes temp storage; keep it inside the container and ephemeral.
ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee

CMD ["node", "index.js"]
