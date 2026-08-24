FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tzdata

# Chromium for the Ads Transparency checker (lib/adscheck). Playwright doesn't
# ship an Alpine build, so we use the distro browser and point playwright at it
# via CHROMIUM_PATH — see lib/adscheck/browser.js. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# stops `npm install` trying (and failing) to fetch the glibc build.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont ca-certificates
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
ARG CACHEBUST=2026-08-24-87
COPY apps/admin-legacy/ ./

# Stamp the build so the running container can state WHICH code it is, exposed
# on /healthz and /api/version. The old marker was a hand-edited string and
# drifted immediately -- it still read a July value weeks later, so it
# confirmed nothing. CACHEBUST already changes every deploy, so reusing it as
# the build id costs nothing and cannot be forgotten.
#
# For the real SHA, set GIT_COMMIT in EasyPanel's build args:
#   GIT_COMMIT=$(git rev-parse --short HEAD)
ARG GIT_COMMIT=""
ENV GIT_COMMIT=${GIT_COMMIT:-$CACHEBUST}
ENV BUILT_AT=${CACHEBUST}

EXPOSE 3000

# Cap the JS heap. With no cap, V8 sizes itself against the HOST's memory and
# happily grows past the container limit, so the kernel OOM-kills the process:
# no stack, no log line, just a dead container. A cap turns that same event
# into a catchable "JavaScript heap out of memory" with a stack trace.
#
# Set NODE_HEAP_MB to roughly 75% of the container's memory limit (leaving room
# for Chromium, which costs ~1GB resident under load, plus native buffers).
# 1536 assumes a 2GB container -- raise it if the container is larger.
ENV NODE_HEAP_MB=1536
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_MB} server.js"]
