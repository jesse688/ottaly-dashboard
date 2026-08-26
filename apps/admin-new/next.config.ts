import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Build-time commit stamp for /api/healthz.
//
// This service builds with NIXPACKS, not the Dockerfile, so the Dockerfile's
// ARG CACHEBUST/GIT_SHA never reaches it. GIT_SHA was instead a HAND-SET env
// var on the Easypanel service, which meant /api/healthz reported the same
// value (13a8777) no matter what was actually deployed — an endpoint that
// looks authoritative while confirming nothing.
//
// Resolving it at build time makes the stamp a property of the build itself:
// it cannot silently go stale, because nobody has to remember to update it.
// Falls back to any platform-provided commit var, then to a timestamp, so a
// build without git metadata still produces something that CHANGES per deploy.
function buildStamp(): string {
  const fromEnv =
    process.env.GIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No git in the build context (Nixpacks copies the source, not the repo).
    // A build timestamp still proves a NEW build shipped, which is the whole
    // point of the check.
    return `build-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
  env: {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    // Inlined at build time and read by /api/healthz.
    BUILD_STAMP: buildStamp(),
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  widenClientFileUpload: true,
  disableLogger: true,
});
