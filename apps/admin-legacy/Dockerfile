FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tzdata

# Run in Europe/London so the server's calendar "today" matches Bison's day
# boundary (Bison stats/charts bucket by London time). Without this the UTC
# container treated 00:00–01:00 BST as the previous/next day and today's stats
# could come back empty.
ENV TZ=Europe/London

WORKDIR /app

# email-finder-local deps (socks package for proxy4smtp)
COPY apps/admin-legacy/email-finder-local/package*.json ./email-finder-local/
RUN cd email-finder-local && npm install --omit=dev

# main server deps
COPY apps/admin-legacy/package*.json ./
RUN npm install --omit=dev

# Cache-bust the source COPY. EasyPanel's Docker cache was reusing an old
# `COPY apps/admin-legacy/ ./` layer even when the commit changed, shipping
# stale code on a "successful" build. Bumping CACHEBUST (any new value each
# deploy) forces this layer — and everything after it — to rebuild.
ARG CACHEBUST=2026-07-23-3
COPY apps/admin-legacy/ ./

EXPOSE 3000

CMD ["node", "server.js"]
