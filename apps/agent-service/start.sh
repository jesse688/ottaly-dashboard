#!/bin/bash
set -e

mkdir -p /root/.ssh
echo "$SSH_PRIVATE_KEY" | base64 -d > /root/.ssh/id_ed25519
chmod 600 /root/.ssh/id_ed25519

echo "StrictHostKeyChecking no" > /root/.ssh/config
chmod 600 /root/.ssh/config

echo "[agent] SSH key ready: $(ssh-keygen -lf /root/.ssh/id_ed25519 2>&1)"

exec node server.js
