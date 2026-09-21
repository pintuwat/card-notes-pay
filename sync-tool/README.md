# Cardpay Gmail Sync

Reads your credit-card e-statement emails from Gmail, unlocks the password-protected
PDFs, extracts each card's **Total Payment Due** per month, and feeds it to the
**Card Notes & Pay** app.

## Runs 24/7 in the cloud

This now runs as part of the same container that serves the app itself (see the
repo-root `Dockerfile`, deployed via Coolify). Tapping **🔄 Sync** in the app hits
`/api/sync` on that same server anytime, day or night — no Mac needs to be on.

- `sync_server.py` serves the static app **and** `/api/sync`, `/api/ping`,
  `/api/annotations` from one process — exactly like it does when run locally.
- `entrypoint.sh` builds `credentials.json`/`config.json` from environment variables
  set in the Coolify dashboard (never committed to git), and keeps `statements/`,
  `annotations.json`, and `token.json` on a persistent `/data` volume so cached
  statements, void/reimburse marks, and the Gmail refresh token survive redeploys.

To rotate a secret (new Gmail token, changed birthdate, etc.), update the relevant
env var in Coolify and redeploy — see the repo-root `Dockerfile` and this folder's
`entrypoint.sh` for exactly which variables it reads
(`CARDPAY_DOB`, `CARDPAY_SINCE`, `GOOGLE_CREDENTIALS_JSON`, `GOOGLE_TOKEN_JSON`,
`GITHUB_PUSH_ENABLED`/`GITHUB_PUSH_TOKEN`/`GITHUB_GIST_ID`).

## One-time setup (before the first cloud deploy)

Gmail's OAuth login needs a real browser, so `credentials.json` and `token.json`
are generated once on your Mac and their contents pasted into Coolify as env vars.
See **SETUP.md** for creating the Google OAuth credential; once `token.json` exists
locally, copy both files' contents into Coolify (`GOOGLE_CREDENTIALS_JSON` /
`GOOGLE_TOKEN_JSON`) rather than running anything long-term on the Mac.

## Running/debugging locally (optional)

The same server still runs locally for testing, exactly as before:
```
python3 sync_server.py
```
Then open `http://localhost:8787`. Needs `credentials.json`, `token.json`, and
`config.json` present in this folder (see SETUP.md) — these are gitignored and
never committed.

### Or: one-off command line (produces a file to import)
```
./sync.sh
```
It will:
1. fetch statement emails from the card issuers (KBANK, CardX/SCB, ttb, KTC, Krungsri, Central The 1),
2. ask your birthdate (used only in memory to derive the PDF passwords — never stored),
3. write **`~/Downloads/cardpay-mydata.json`**.

Then in the app: **⚙ Settings → Import (.json)** → pick that file.

Run the steps manually if you prefer:
```
python3 fetch_statements.py                 # downloads PDFs to ./statements/
CARDPAY_DOB=DD/MM/YYYY python3 parse_statements.py   # -> ~/Downloads/cardpay-mydata.json
```

## How passwords work
Every issuer locks the PDF with your birthdate in its own format. They are all derived
from one date (`CARDPAY_DOB`):

| Issuer | Format | Example (23 May 1996) |
|---|---|---|
| KTC | ddMmmyy | `23May96` |
| KBANK, CardX/SCB | DDMMYYYY | `23051996` |
| ttb, Krungsri, Central The 1 | ddMmmyyyy | `23May1996` |

## Notes / limits
- The app stores **Total Payment Due** per card per month (what you owe that statement).
- Krungsri / Central The 1 may only appear when you request a statement copy (they don't
  always email monthly e-statements to this address).
- Non-card mail (mutual funds, savings accounts, brokerage, installment receipts, NCB
  letters) is automatically skipped.
- `import` **replaces** the app's data with this file. Edits you make in the app
  (notes, QR images) are not preserved across a re-import — re-import is for refreshing
  the statement numbers.

## Security
- `.gitignore` blocks `credentials.json`, `token.json`, `statements/`, and `*.json`
  from being committed. This folder is **not** part of the public app repo.
- In the cloud deployment, the same secrets live as environment variables in the
  Coolify dashboard instead of as local files — they still never go into git or the
  Docker image.
- Gmail scope is **read-only**. Token can be revoked anytime at
  https://myaccount.google.com/permissions
