FROM node:20-alpine

# better-sqlite3 is a native module, so it needs a toolchain to build. Alpine
# ships without one.
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

COPY apps/mailbox-service/package.json ./package.json
RUN npm install --omit=dev

# Cache-bust the source COPY. EasyPanel's Docker cache has been observed reusing
# an old `COPY apps/<app> ./` layer even when the commit changed, shipping stale
# code from a "successful" build. admin-new and admin-legacy both carry this
# guard for the same reason. Bump CACHEBUST to force this layer, and every layer
# after it, to rebuild.
ARG CACHEBUST=2026-09-18-initial
COPY apps/mailbox-service .

# Stamp the build so /healthz can report which commit is actually running. A
# deploy that "succeeded" in one second has shipped nothing, and without this
# the only way to tell is behaviour.
ARG GIT_SHA=unset
ENV GIT_SHA=$GIT_SHA

# SQLite lives on a mounted volume. Cumulative sends are stitched from 90-day
# windows and cannot be re-derived once a day falls out of PlusVibe's reach, so
# this path must be a persistent volume, not container storage.
ENV MAILBOX_DB=/data/mailbox.db
ENV MAILBOX_BACKUP_DIR=/data/backups
RUN mkdir -p /data/backups

ENV PORT=3002
EXPOSE 3002

CMD ["node", "server.js"]
