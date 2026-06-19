# Crawlee (3.17) takes memory snapshots by spawning the `ps` command and there is
# no reliable env/config switch to avoid it — so `ps` MUST exist in the image.
# apify/actor-node is Crawlee's own Cheerio image and ships procps. We also
# install it explicitly + verify at build time so a missing `ps` fails the BUILD
# (loud) instead of every scrape job at runtime (silent crash).
FROM apify/actor-node:20

USER root
RUN apk add --no-cache procps \
    && which ps \
    && ps --version 2>/dev/null || ps -A -o ppid,pid,stat,rss,comm | head -1

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-optional

COPY . .

ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee

CMD ["node", "index.js"]
