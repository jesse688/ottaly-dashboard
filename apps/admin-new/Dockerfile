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
# Cache-bust: copy the deploy-trigger FIRST and stamp it into an ARG so every
# deploy whose trigger changed invalidates the source COPY + build below. Without
# this, EasyPanel's Docker layer cache serves a stale `COPY apps/admin-new .` and
# `npm run build` — the deploy "succeeds" in seconds but runs OLD code. Bump
# apps/admin-new/.deploy-trigger to force a real rebuild. (Same guard client-portal
# needed in #37.)
COPY apps/admin-new/.deploy-trigger ./.deploy-trigger
ARG CACHE_BUST=unset
RUN echo "build for: ${CACHE_BUST}" && cat ./.deploy-trigger
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
