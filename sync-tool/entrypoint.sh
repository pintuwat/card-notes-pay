#!/bin/sh
# Materializes the secrets this container needs from env vars (set in the
# Coolify dashboard, never committed to git) into the files sync_server.py
# already expects, then starts it. State that should survive redeploys
# (cached statement PDFs, voided/reimbursed marks, the refreshed Gmail
# token) lives on the /data volume and is symlinked into place.
set -e
cd "$(dirname "$0")"

mkdir -p /data/statements

if [ ! -f /data/annotations.json ]; then
  printf '%s' '{"voided":[],"reimbursed":[]}' > /data/annotations.json
fi

if [ ! -f /data/token.json ] && [ -n "$GOOGLE_TOKEN_JSON" ]; then
  printf '%s' "$GOOGLE_TOKEN_JSON" > /data/token.json
fi

if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  printf '%s' "$GOOGLE_CREDENTIALS_JSON" > credentials.json
fi

if [ -z "$CARDPAY_DOB" ]; then
  echo "[entrypoint] WARNING: CARDPAY_DOB is not set — statement PDFs won't unlock." >&2
fi

cat > config.json <<EOF
{
  "dob": "${CARDPAY_DOB}",
  "since": "${CARDPAY_SINCE:-2026/01/01}",
  "app_dir": "/app",
  "port": ${CARDPAY_PORT:-8787},
  "github_push": {
    "enabled": ${GITHUB_PUSH_ENABLED:-false},
    "token": "${GITHUB_PUSH_TOKEN}",
    "gist_id": "${GITHUB_GIST_ID}"
  }
}
EOF

ln -sf /data/statements statements
ln -sf /data/annotations.json annotations.json
ln -sf /data/token.json token.json
ln -sf /data/state.json state.json

exec python3 sync_server.py
