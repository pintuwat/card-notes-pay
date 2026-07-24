# Cardpay Gmail Sync

Reads your credit-card e-statement emails from Gmail, unlocks the password-protected
PDFs, extracts each card's **Total Payment Due** per month, and writes an import file
for the **Card Notes & Pay** app. Runs entirely on your Mac — nothing is uploaded.

## One-time setup
See **SETUP.md** (create a Google OAuth credential, save `credentials.json` here,
`pip3 install -r requirements.txt`).

## Best: one-tap Sync from inside the app
One command does both — fetches the latest statements from Gmail **and** starts
serving the app:
```
python3 sync_server.py
```
It prints URLs — **open the app from one of them** (not the github.io URL):
- on this Mac: `http://localhost:8787`
- on your phone (same Wi-Fi): `http://<your-mac-name>.local:8787` (e.g. `http://MacbookAir.local:8787`)

The first thing it does on startup is read Gmail and parse the latest
statements in the background while it starts serving, so opening the app
right after already has fresh data. Tap **🔄 Sync** anytime after that for
another refresh. Your birthdate (for the PDF passwords) lives in `config.json`
on this Mac.

### Important: the public github.io app can't auto-sync
The hosted app is **HTTPS**; this server is **HTTP**. Browsers (especially iOS)
**block HTTPS pages from calling HTTP servers**, so on the github.io app Sync
falls back to file import. For one-tap sync **on your phone**, add the
`….local:8787` URL above to your Home Screen and use *that* app.

> Want sync on the public app from anywhere? Put the server behind an HTTPS
> tunnel (e.g. `cloudflared`) and paste that https URL into the app under
> **⚙ Settings → Sync server** (add a secret token first — an open tunnel would
> expose your data).

## Or: command-line (produces a file to import)
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
- Gmail scope is **read-only**. Token can be revoked anytime at
  https://myaccount.google.com/permissions
