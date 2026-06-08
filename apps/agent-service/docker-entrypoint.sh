#!/bin/sh
# Seed agent files from defaults if /app/agents volume is empty (first deploy)
if [ ! -f /app/agents/ops/system-prompt.md ]; then
  echo "Seeding agent files from defaults..."
  cp -r /app/agents-default/. /app/agents/
  echo "Done."
fi

exec node server.js
