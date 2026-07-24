#!/usr/bin/env python3
"""
Fetch credit-card 'statement' emails from Gmail via OAuth and download their
attachments — so we can see exactly what each bank sends before building parsers.

This is a LOCAL tool. It never uploads anything. Auth stays on this Mac:
  - credentials.json : OAuth client you create in Google Cloud Console (you provide)
  - token.json       : created on first run after you approve in the browser

Usage:
  python3 fetch_statements.py                 # default: subject:statement after 2026/01/01
  python3 fetch_statements.py --since 2026/01/01
  python3 fetch_statements.py --query 'subject:(statement OR e-statement) after:2026/1/1'

Output:
  - prints a summary of every matching email (from / date / subject / attachments)
  - saves each attachment into ./statements/
  - writes ./statements/_emails.json with bodies + metadata for inspection
"""

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "statements"
TOKEN = HERE / "token.json"
CREDS = HERE / "credentials.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def die(msg):
    print("\n[!] " + msg + "\n")
    sys.exit(1)


def get_service():
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        die("Missing libraries. Run:\n    pip3 install -r requirements.txt")

    creds = None
    if TOKEN.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if os.environ.get("CARDPAY_NO_BROWSER"):
                die("Re-authorization needed. Run ./sync.sh once in Terminal to sign in again.")
            if not CREDS.exists():
                die("credentials.json not found.\n"
                    "    Create an OAuth client (Desktop app) in Google Cloud Console,\n"
                    "    download it, and save it here as:\n    " + str(CREDS) +
                    "\n    (See SETUP.md for the step-by-step.)")
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN.write_text(creds.to_json())
        print("[ok] token saved to token.json")
    from googleapiclient.discovery import build
    return build("gmail", "v1", credentials=creds)


def _walk_parts(parts, acc):
    """Collect body text and attachment part refs from a MIME tree."""
    for p in parts or []:
        mime = p.get("mimeType", "")
        body = p.get("body", {})
        filename = p.get("filename", "")
        if filename and (body.get("attachmentId") or body.get("data")):
            acc["attachments"].append(p)
        if mime == "text/plain" and body.get("data"):
            acc["text"].append(base64.urlsafe_b64decode(body["data"]).decode("utf-8", "replace"))
        elif mime == "text/html" and body.get("data"):
            acc["html"].append(base64.urlsafe_b64decode(body["data"]).decode("utf-8", "replace"))
        if p.get("parts"):
            _walk_parts(p["parts"], acc)


def html_to_text(html):
    html = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    html = re.sub(r"(?is)<br\s*/?>", "\n", html)
    html = re.sub(r"(?is)</(p|div|tr|table|li|h[1-6])>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)[:80]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026/01/01", help="Gmail date, YYYY/MM/DD")
    ap.add_argument("--query", default=None, help="raw Gmail search query (overrides --since)")
    ap.add_argument("--max", type=int, default=200)
    args = ap.parse_args()

    # Card-issuer senders (reliable: catches every monthly statement regardless of subject).
    ISSUERS = ("kasikornbank.com OR cardx.co.th OR eservice.ttbbank.com OR "
               "ktc.co.th OR krungsri.com OR centralthe1card.com OR uob.co.th")
    # UOB doesn't email e-statements to this address — they arrive self-forwarded from
    # your own address instead, so catch those by subject ("Uob statement", "Uob july", ...).
    query = args.query or f'(from:({ISSUERS}) OR subject:uob) has:attachment after:{args.since}'
    OUT.mkdir(exist_ok=True)
    svc = get_service()

    print(f"\n[search] {query}\n")
    msgs, page = [], None
    while True:
        resp = svc.users().messages().list(userId="me", q=query, pageToken=page, maxResults=100).execute()
        msgs.extend(resp.get("messages", []))
        page = resp.get("nextPageToken")
        if not page or len(msgs) >= args.max:
            break
    if not msgs:
        print("No emails matched. Try a broader --query, e.g.\n"
              "  --query 'subject:(statement OR e-statement OR ใบแจ้งยอด) after:2026/1/1'")
        return

    # Accumulate across runs: keep prior emails, merge in newly fetched ones (keyed by
    # Gmail message id). Deterministic filenames so re-fetching the same statement just
    # overwrites instead of duplicating. This lets later runs fetch ONLY the current
    # month while the parser still rebuilds the full dataset from everything on disk.
    EMAILS = OUT / "_emails.json"
    by_id = {}
    if EMAILS.exists():
        try:
            for r in json.load(open(EMAILS)):
                if r.get("id"):
                    by_id[r["id"]] = r
        except Exception:
            pass

    print(f"Found {len(msgs)} email(s) in this window:\n" + "-" * 72)
    new_files = 0
    for i, m in enumerate(msgs, 1):
        mid = m["id"]
        msg = svc.users().messages().get(userId="me", id=mid, format="full").execute()
        headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
        acc = {"text": [], "html": [], "attachments": []}
        payload = msg["payload"]
        if payload.get("parts"):
            _walk_parts(payload["parts"], acc)
        elif payload.get("body", {}).get("data"):
            data = base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", "replace")
            (acc["html"] if "html" in payload.get("mimeType", "") else acc["text"]).append(data)

        body_text = "\n".join(acc["text"]).strip() or html_to_text("\n".join(acc["html"]))
        sender = headers.get("from", "?")
        subject = headers.get("subject", "?")
        date = headers.get("date", "?")

        saved = []
        for a in acc["attachments"]:
            fn = a.get("filename", "attachment")
            out = OUT / f"{safe_name(sender.split('<')[0])[:24]}_{mid[:12]}_{safe_name(fn)}"
            if not out.exists():
                aid = a["body"].get("attachmentId")
                if aid:
                    att = svc.users().messages().attachments().get(userId="me", messageId=mid, id=aid).execute()
                    raw = base64.urlsafe_b64decode(att["data"])
                else:
                    raw = base64.urlsafe_b64decode(a["body"]["data"])
                out.write_bytes(raw)
                new_files += 1
            saved.append(out.name)

        has_tx = bool(re.search(r"\d[\d,]*\.\d{2}", body_text))
        print(f"{i:>2}. {date}  | {sender.split('<')[0].strip()[:32]} | files: {len(saved)}")
        by_id[mid] = {
            "id": mid, "from": sender, "date": date, "subject": subject,
            "body_text": body_text, "attachments": saved, "body_has_amounts": has_tx,
        }

    EMAILS.write_text(json.dumps(list(by_id.values()), ensure_ascii=False, indent=2))
    total_files = len(list(OUT.glob("*.pdf")) + list(OUT.glob("*.PDF")))
    print("-" * 72)
    print(f"New files this run: {new_files} | total statements on disk: {total_files} | "
          f"emails tracked: {len(by_id)}")


if __name__ == "__main__":
    main()
