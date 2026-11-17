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

# Seed the Gmail token from the env var on first boot, and again whenever the env
# var changes (e.g. after revoking and re-authorizing) — otherwise the old token
# already on the /data volume would keep being used. Between changes, the token
# file the fetcher refreshes in place is left alone.
if [ -n "$GOOGLE_TOKEN_JSON" ]; then
  env_sha=$(printf '%s' "$GOOGLE_TOKEN_JSON" | sha256sum | cut -d' ' -f1)
  if [ ! -f /data/token.json ] || [ "$(cat /data/.token_env_sha 2>/dev/null)" != "$env_sha" ]; then
    printf '%s' "$GOOGLE_TOKEN_JSON" > /data/token.json
    printf '%s' "$env_sha" > /data/.token_env_sha
    echo "[entrypoint] Gmail token loaded from GOOGLE_TOKEN_JSON"
  fi
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
