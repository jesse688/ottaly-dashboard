# Crawlee's Playwright image — bundles Chromium + Playwright + all OS deps, and
# ships `ps` (procps) which Crawlee's memory snapshot needs. This is heavier than
# the Cheerio-only image (~1GB) and Chromium needs RAM, so give the Easypanel
# container ≥2GB. The worker uses Cheerio FIRST and only falls back to Playwright
# for blocked/JS sites when PLAYWRIGHT_FALLBACK=1.
FROM apify/actor-node-playwright-chrome:20

# procps for the memory snapshot (the base image is Debian-based; apt not apk).
USER root
RUN (apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*) || true \
    && (which ps || true)

WORKDIR /app

COPY package.json package-lock.json* ./
# The base image already has playwright + chromium installed globally; install
# our remaining prod deps. Don't re-download browsers (image already has them).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-optional

COPY . .

ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee

CMD ["node", "index.js"]
