#!/bin/bash
# Deploy server to Pi and restart. Requires: SSHPASS env var (or sshpass -p).
#   SSHPASS=xxx ./deploy.sh

set -e
PI_HOST="${PI_HOST:-192.168.8.142}"
PI_USER="${PI_USER:-ffboss}"
REMOTE="${PI_USER}@${PI_HOST}"
REMOTE_PATH="~/ff2026-final-boss/server"
SSH_OPTS="-o StrictHostKeyChecking=no"

echo "Deploying to ${REMOTE}..."
sshpass -p "${SSHPASS}" rsync -avz -e "ssh ${SSH_OPTS}" \
  --exclude node_modules --exclude .env \
  ./server/ "${REMOTE}:${REMOTE_PATH}/"

echo "Restarting ff2026-boss..."
sshpass -p "${SSHPASS}" ssh ${SSH_OPTS} "${REMOTE}" \
  'sudo systemctl restart ff2026-boss && systemctl is-active ff2026-boss'

echo "Done. http://${PI_HOST}:3000"
