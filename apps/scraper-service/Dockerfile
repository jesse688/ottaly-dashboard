# Cheerio-based scraper — no browser needed, so a slim Node image is enough.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Crawlee writes temp storage; keep it inside the container and ephemeral.
ENV CRAWLEE_STORAGE_DIR=/tmp/crawlee

CMD ["node", "index.js"]
