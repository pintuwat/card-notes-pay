# Runs the Card Notes & Pay app + its Gmail sync API from one container.
# sync-tool/sync_server.py already serves the static app AND /api/sync,
# /api/ping, /api/annotations, so this replaces the static-only deploy —
# same domain, same paths, the app's Sync button just starts working.
FROM python:3.11-slim

RUN pip install --no-cache-dir \
        google-api-python-client>=2.0.0 \
        google-auth>=2.0.0 \
        google-auth-oauthlib>=1.0.0 \
        pymupdf>=1.23.0 \
    && mkdir -p /root/Downloads

WORKDIR /app
COPY . .

RUN chmod +x sync-tool/entrypoint.sh

WORKDIR /app/sync-tool
EXPOSE 8787
ENTRYPOINT ["/bin/sh", "/app/sync-tool/entrypoint.sh"]
