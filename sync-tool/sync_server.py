#!/usr/bin/env python3
"""
Local sync server for Card Notes & Pay.

Serves the app's static files AND a /api/sync endpoint that, on demand, reads
your Gmail statements, parses them, and returns the import JSON. The app's Sync
button calls /api/sync so one tap reads the latest mail — no manual file import.

Run:   python3 sync_server.py
Then open the printed URL:
  - on this Mac:  http://localhost:8787
  - on your phone (same Wi-Fi):  http://<your-mac-ip>:8787

Everything stays on your Mac. config.json holds your birthdate (to derive the
PDF passwords) and the app folder path.
"""
import base64, json, os, socket, ssl, subprocess, sys, threading, urllib.request, urllib.error
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
try:
    import certifi as _certifi
    _SSL_CTX = ssl.create_default_context(cafile=_certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()

HERE = Path(__file__).resolve().parent
CFG = json.load(open(HERE / "config.json"))
APP_DIR = CFG.get("app_dir") or str(HERE.parent)  # default: the app folder one level up
PORT = int(CFG.get("port", 8787))
DOB = CFG["dob"]
SINCE = CFG.get("since", "2026/01/01")
DOWNLOAD = Path(os.path.expanduser("~/Downloads/cardpay-mydata.json"))

_lock = threading.Lock()


STATEMENTS = HERE / "statements"


def is_first_sync():
    return not (STATEMENTS / "_emails.json").exists()


def _gist_request(method, url, token, body=None):
    headers = {"Authorization": f"token {token}", "Content-Type": "application/json",
                "Accept": "application/vnd.github.v3+json", "User-Agent": "cardpay-sync/1.0"}
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=_SSL_CTX) as resp:
        return json.loads(resp.read())


def push_to_github(raw_json: bytes):
    """Push data JSON to a private GitHub Gist (background thread).

    First run: creates the Gist and saves its ID to config.json.
    Later runs: updates the existing Gist.
    iPhone reads from the secret raw Gist URL (no auth needed).
    """
    gh = CFG.get("github_push", {})
    if not gh.get("enabled") or not gh.get("token"):
        return
    token = gh["token"]
    content = raw_json.decode()
    gist_id = gh.get("gist_id", "")

    try:
        if gist_id:
            _gist_request("PATCH", f"https://api.github.com/gists/{gist_id}", token,
                          {"files": {"cardpay-mydata.json": {"content": content}}})
            print(f"[gist] updated gist {gist_id[:8]}…")
        else:
            result = _gist_request("POST", "https://api.github.com/gists", token, {
                "description": "CardPay sync data",
                "public": False,
                "files": {"cardpay-mydata.json": {"content": content}},
            })
            gist_id = result["id"]
            username = result["owner"]["login"]
            stable_url = f"https://gist.githubusercontent.com/{username}/{gist_id}/raw/cardpay-mydata.json"
            # Save gist_id so future syncs update instead of create
            cfg_path = HERE / "config.json"
            cfg = json.loads(cfg_path.read_text())
            cfg["github_push"]["gist_id"] = gist_id
            cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
            CFG["github_push"]["gist_id"] = gist_id
            print(f"[gist] created new private gist!")
            print(f"[gist] iPhone URL (stable): {stable_url}")
    except Exception as e:
        print(f"[gist] push failed: {e}")


def run_sync():
    """Run fetch + parse; return (ok, payload_or_error).

    First sync: fetch the full history (config 'since').
    Later syncs: fetch only the current month — fast — while the parser still
    rebuilds the complete dataset from all statements accumulated on disk.
    """
    env = dict(os.environ, CARDPAY_DOB=DOB, CARDPAY_NO_BROWSER="1")
    first = is_first_sync()
    since = SINCE if first else datetime.now().strftime("%Y/%m/01")
    print(f"[sync] mode={'FULL (first run)' if first else 'current month'} since={since}")
    try:
        f = subprocess.run([sys.executable, str(HERE / "fetch_statements.py"),
                            "--since", since], cwd=HERE, env=env,
                           capture_output=True, text=True, timeout=180)
        if f.returncode != 0:
            return False, (f.stdout + f.stderr)[-500:]
        p = subprocess.run([sys.executable, str(HERE / "parse_statements.py")],
                           cwd=HERE, env=env, capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            return False, (p.stdout + p.stderr)[-500:]
        return True, json.loads(DOWNLOAD.read_text())
    except subprocess.TimeoutExpired:
        return False, "Timed out talking to Gmail."
    except Exception as e:
        return False, str(e)


def _sync_and_push():
    """Run fetch+parse, push the result to the gist, print status. Shared by the
    HTTP /api/sync handler and the automatic sync that fires when the server starts."""
    print("[sync] reading Gmail…")
    ok, payload = run_sync()
    if ok:
        n = len(payload.get("spending", []))
        print(f"[sync] done — {len(payload.get('cards', []))} cards, {n} card-months")
        raw = DOWNLOAD.read_bytes()
        threading.Thread(target=push_to_github, args=(raw,), daemon=True).start()
    else:
        print("[sync] failed:", payload)
    return ok, payload


def _startup_sync():
    """Kick a sync right when the server comes up, so the very command that starts
    serving also fetches the latest statements — no separate fetch step or app tap needed."""
    if not _lock.acquire(blocking=False):
        return
    try:
        _sync_and_push()
    finally:
        _lock.release()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP_DIR, **k)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        if self.path.rstrip("/") == "/api/sync":
            return self.handle_sync()
        self.send_error(404)

    def do_GET(self):
        p = self.path.split("?")[0].rstrip("/")
        if p == "/api/ping":
            return self._json(200, {"ok": True, "service": "cardpay-sync"})
        if p == "/api/sync":
            return self.handle_sync()
        return super().do_GET()

    def handle_sync(self):
        if not _lock.acquire(blocking=False):
            return self._json(429, {"ok": False, "error": "A sync is already running."})
        try:
            ok, payload = _sync_and_push()
            if ok:
                self._json(200, payload)
            else:
                self._json(500, {"ok": False, "error": payload})
        finally:
            _lock.release()

    def log_message(self, *a):
        pass  # quiet


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class QuietHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True  # avoids "Address already in use" after a crash/restart

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], ConnectionResetError):
            return  # iPhone drops connection during reachability probes — not an error
        super().handle_error(request, client_address)


def main():
    if not (HERE / "token.json").exists():
        print("⚠  No token.json yet — run ./sync.sh once to authorize Gmail first.")
    srv = QuietHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    print("\n  Card Notes & Pay — local sync server")
    print(f"  ▶ On this Mac:   http://localhost:{PORT}")
    print(f"  ▶ On your phone: http://{ip}:{PORT}   (same Wi-Fi)")
    print("  Fetching the latest statements now, then serving. Tap 🔄 Sync in the app anytime for another refresh.")
    print("  Ctrl+C to stop.\n")
    threading.Thread(target=_startup_sync, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
