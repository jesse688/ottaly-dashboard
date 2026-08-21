FROM node:20-alpine AS base

# ── deps: install production dependencies ──────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY apps/admin-new/package.json ./package.json
RUN npm install --legacy-peer-deps

# ── builder: compile the Next.js app ──────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Cache-bust the source COPY. EasyPanel's Docker cache has been observed reusing
# an old `COPY apps/<app> ./` layer even when the commit changed, shipping stale
# code from a "successful" build -- admin-legacy carries the same guard for the
# same reason. Bump CACHEBUST (any new value) to force this layer, and every
# layer after it, to rebuild.
ARG CACHEBUST=2026-08-21-1
COPY apps/admin-new .
ENV NEXT_TELEMETRY_DISABLED=1
# Suppress Sentry source-map upload during build (no auth token in CI)
ENV SENTRY_AUTH_TOKEN=""
ENV SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_WARN=true
RUN npm run build

# ── runner: minimal production image ─────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
