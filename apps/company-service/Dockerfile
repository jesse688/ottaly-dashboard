# Lightweight — no browser needed (unlike scraper-service). better-sqlite3 needs
# python3/make/g++ to compile the native addon for reading the CCOD index, same
# as admin-legacy's Dockerfile.
FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tzdata

# Match admin-legacy: the server's "today" should be London so any date logic
# lines up with the rest of the stack.
ENV TZ=Europe/London

WORKDIR /app

COPY apps/company-service/package*.json ./
RUN npm install --omit=dev

# Cache-bust the source COPY. EasyPanel's Docker cache reuses an old
# `COPY ... ./` layer even when the commit changes, shipping stale code on a
# "successful" build. Bump CACHEBUST (any new value) each deploy to force this
# layer — and everything after it — to rebuild.
ARG CACHEBUST=2026-07-24-11
COPY apps/company-service/ ./

EXPOSE 3100

CMD ["node", "index.js"]
