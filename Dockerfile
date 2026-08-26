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

# Cache-bust the source COPY. EasyPanel's Docker cache has reused this layer
# even when the commit changed, shipping stale code on a build it reported as
# successful. Bump CACHEBUST (any new value) every deploy to force this layer —
# and everything after it — to rebuild.
#
# THIS is the Dockerfile EasyPanel builds. apps/admin-legacy/Dockerfile is an
# unused copy that drifted stale; edit this one.
ARG CACHEBUST=2026-08-27-brief-01

# copy all admin-legacy files (server.js, email-finder-local/, public/, etc.)
COPY apps/admin-legacy/ ./

# Stamp the build so the running container can say WHICH code it is, on
# /healthz. Without this a deploy cannot be verified and every conclusion
# drawn from behaviour afterwards is guesswork.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=${GIT_COMMIT:-$CACHEBUST}
ENV BUILT_AT=${CACHEBUST}

EXPOSE 3000 6080
CMD ["node", "server.js"]
