FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY apps/client-portal/package.json ./package.json
RUN npm install

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Cache-bust: copy the deploy-trigger FIRST and stamp it into an ARG so every
# deploy whose trigger changed invalidates the source COPY + build below. Without
# this, EasyPanel's Docker layer cache served a stale `COPY apps/client-portal .`
# and `npm run build` — deploys "succeeded" in ~2s but ran OLD code (every fix
# landed one commit behind). Bump apps/client-portal/.deploy-trigger to force a
# real rebuild.
COPY apps/client-portal/.deploy-trigger ./.deploy-trigger
ARG CACHE_BUST=unset
RUN echo "build for: ${CACHE_BUST}" && cat ./.deploy-trigger
COPY apps/client-portal .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
