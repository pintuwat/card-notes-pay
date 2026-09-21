# Runs the Card Notes & Pay app + its Gmail sync API from one container.
# sync-tool/sync_server.py already serves the static app AND /api/sync,
# /api/ping, /api/annotations, so this replaces the static-only deploy —
# same domain, same paths, the app's Sync button just starts working.
FROM python:3.11-slim

# Unbuffered stdout so print() shows up in Coolify's logs immediately
# instead of sitting in Python's buffer until the process exits.
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY sync-tool/requirements.txt sync-tool/requirements.txt
RUN pip install --no-cache-dir -r sync-tool/requirements.txt \
    && mkdir -p /root/Downloads

COPY . .

RUN chmod +x sync-tool/entrypoint.sh

WORKDIR /app/sync-tool
EXPOSE 8787
ENTRYPOINT ["/bin/sh", "/app/sync-tool/entrypoint.sh"]
