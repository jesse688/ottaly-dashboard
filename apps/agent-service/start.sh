#!/bin/bash
set -e

# Write SSH key properly preserving newlines
mkdir -p /root/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > /root/.ssh/id_ed25519
chmod 600 /root/.ssh/id_ed25519

# SSH config
cat > /root/.ssh/config << 'EOF'
Host *
  StrictHostKeyChecking no
  IdentityFile /root/.ssh/id_ed25519
EOF
chmod 600 /root/.ssh/config

echo "[agent] SSH key written"
echo "[agent] Key fingerprint: $(ssh-keygen -lf /root/.ssh/id_ed25519 2>&1)"

exec node server.js
