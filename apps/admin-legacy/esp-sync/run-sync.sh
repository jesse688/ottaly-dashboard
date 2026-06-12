#!/bin/sh
# ESP Sync — run this on a cron schedule in Easypanel
# Cron: 0 * * * * (every hour)
# Add to Easypanel ottaly-stable service → Advanced → Cron Jobs

cd /app
node esp-sync/sync.js 2>&1 | tee -a /tmp/esp-sync.log
