# Card Notes & Pay — Family Spending Monitor Roadmap

Copy-paste prompts for the coding agent, one per phase. Paste the **Shared context** at the top of
every prompt. Suggested order: 1 → 2 → 3 → 4 → 5 → 6.

| # | Phase | Status |
|---|---|---|
| 0 | Show full merchant names in the statement transaction list | Done (commit `1b67abf`, pushed) |
| 1 | Foundation: SQLite, login, roles | To do |
| 2 | Each person's own Gmail sync | To do |
| 3 | Daily ledger (spending not on a card) | To do |
| 4 | Slip capture from the iPhone | To do |
| 5 | Family tracking and reports | To do |
| 6 | Backups and hardening | To do |

## Decisions so far

- 1 owner + 2–3 family members; each member connects their own Gmail for statement sync.
- HTTPS is set up by the owner in Coolify (Phase 1 and 2 depend on it; Google only accepts a non-https OAuth redirect for localhost).
- Slips are read on the iPhone (Shortcut) and sent as text/fields. The server does light regex parsing only: no OCR and no outside API.
- A PWA cannot receive iOS share-sheet items (no Web Share Target in Safari), and Shortcuts has no "new photo" trigger, so slip capture uses in-app upload, a share-sheet Shortcut, and a daily album Shortcut.

## Things to verify yourself

- **Google OAuth consent screen:** an app left in "Testing" mode issues refresh tokens that expire after 7 days. The usual fix is to set it to "In production" and re-authorize. This comes from developer-forum answers, not Google's own docs, so confirm it in your Google Cloud console.
- **Shortcuts uploads:** send photos as a **Form** body (not File); Shortcuts ignores a manually set `Content-Type` header. Action names and behavior can differ by iOS version, so test on your own iPhone.
- **Coolify HTTPS:** check that certificates work on your chosen domain (a domain you own is safer than `sslip.io`).

---

## Shared context

Paste this at the top of every prompt below.

```
PROJECT: "Card Notes & Pay" — vanilla-JS PWA (index.html, js/app.js, js/db.js with per-device IndexedDB, js/i18n.js Thai/English, css/styles.css, sw.js network-first service worker) served together with a Python stdlib HTTP server (sync-tool/sync_server.py) in a Docker container on Coolify (Oracle VM), with a persistent volume at /data. sync-tool/fetch_statements.py pulls statement PDFs from Gmail, sync-tool/parse_statements.py parses them (with a per-PDF result cache). sync-tool/entrypoint.sh builds config from env vars. Secrets live only in Coolify env vars or /data, never in git. Repo: main branch.
RULES: Read the relevant code before changing it. Make one logical change at a time, verify it in the browser preview (python3 -m http.server 4173 config is "cardpay" in .claude/launch.json) at 375px mobile width, and run the Python scripts you touch. Keep Thai/English i18n and the dark/light theme working. No new dependencies unless I approve them. Never read or print credentials.json, token.json or any secret. Commit each logical step separately with a clear message. Do NOT push; I will ask. Start by writing a short plan and listing any question you cannot answer from the code.
DECISIONS SO FAR: 1 owner + 2–3 family members. Each member connects their own Gmail for statement sync. HTTPS is set up by me in Coolify. Slips are read on the iPhone (Shortcut) and sent as text/fields; the server never calls an outside OCR service.
```

---

## Prompt 0 — Transaction list names (DONE)

Fixed in commit `1b67abf`: descriptions wrap to 2 lines and a tap expands the full text; swipe-to-delete unaffected. Kept here for reference.

```
In the Card Notes & Pay repo, fix the statement transaction list: long merchant names are cut off with an ellipsis (.tx-desc in css/styles.css, built by txRow() in js/app.js). Let the description wrap to up to 2 lines, and make a tap on the row expand it to the full text. Do not break swipe-to-delete (attachSwipeDelete), and keep the amount and date columns aligned. Verify in the browser preview at mobile width (375px) with a very long name, then commit.
```

---

## Prompt 1 — Foundation (database, login, roles)

```
GOAL: Let family members log in safely. Today every /api/* route is open to anyone who knows the URL, and shared data is one state.json blob.
BUILD:
1. SQLite at /data/app.db using Python's built-in sqlite3. Create a schema_version table and a small migration runner. Import the existing /data/state.json into the new tables once, without losing anything, and keep a copy of the original file. Keep the app working offline from its IndexedDB cache and sync it with the server.
2. Auth: users table (name, email or username, role, password hash), passwords hashed with hashlib.scrypt (or pbkdf2 if scrypt is unavailable), random per-user salt, constant-time compare. Server-side sessions in the database, cookie that is HttpOnly + SameSite=Lax + Secure, expiry, logout, login rate limiting per IP and per user. Reject login unless the request arrived over HTTPS (trust X-Forwarded-Proto from Coolify's proxy only), except on localhost for development.
3. Roles: owner (everything, including settings, members, sync), member (add/edit their own entries, view household), viewer (read-only).
4. First run: if no users exist, show a one-time "create owner account" screen. Owner invites others with a single-use invite link that expires; the invitee sets their own password.
5. Protect every existing /api route by role. Return 401/403 JSON the app handles by showing the login screen.
6. UI: login screen, logout, Members page in Settings (list, invite, change role, disable). Use the existing i18n and theme.
ACCEPTANCE: unauthenticated requests get 401; a viewer cannot write; passwords never appear in logs or responses; existing data is intact after migration; the app still works with the server unreachable. Show me the exact Coolify changes needed (domain, HTTPS, env vars, volume) in plain steps.
```

---

## Prompt 2 — Each person's own Gmail sync

```
GOAL: Each household member can connect their own Gmail so their card statements are fetched and parsed, and the Sync button only runs for the logged-in person's own mailbox (owner can sync everyone).
BUILD:
1. Replace the single GOOGLE_TOKEN_JSON/CARDPAY_DOB setup with per-user storage in SQLite: Gmail refresh token (encrypted at rest with a key from an env var), and the person's PDF-password source. The birthdate used to derive PDF passwords must be encrypted at rest and never logged or returned by any API.
2. Gmail connect flow in the browser: "Connect my Gmail" in Settings starts the Google OAuth web flow (read-only Gmail scope) with a redirect to our own HTTPS domain, stores the token for that user only, and shows connected/disconnected status. Add the redirect URI setup steps for the Google Cloud console and tell me what to set in env vars. Note for me: the consent screen must be set to "In production" or refresh tokens expire after 7 days; list the exact clicks and any warnings I will see.
3. Make fetch_statements.py and parse_statements.py run per user: separate statements folder and parse cache per user (/data/users/<id>/statements), results tagged with that user and merged into the household data. Keep the existing per-PDF parse cache and skip-stored-emails speed-ups. Migrate the current owner token/statements into the owner's account without re-downloading.
4. Sync endpoint: members can sync only themselves; owner can sync all; one sync per user at a time; keep the 300s timeouts and clear error messages ("Gmail not connected", "Token expired, reconnect").
5. Each card/transaction belongs to a user; household views show everyone's cards labelled by owner, and members see only what the household sharing setting allows.
ACCEPTANCE: two test accounts can each connect a mailbox and sync without seeing each other's raw emails or PDFs; revoking access in Google shows a clear reconnect prompt; no secret or birthdate appears in logs, API responses or git.
```

---

## Prompt 3 — Daily spending ledger (money not on a card)

```
GOAL: Add a "Daily" tab for spending not on a credit card: cash, QR, bank transfer, e-wallet.
BUILD:
- Entry fields: amount, date and time, merchant, category, payment method, who spent it (a household member), shared or personal, note, optional photo, source (manual, slip, import), created by.
- Default categories (Thai + English): food, groceries, transport, utilities, rent, kids, health, shopping, entertainment, other. Owner can add, rename and hide categories.
- Screens: today view with a day total and the list; two-tap quick add (amount + category, everything else defaults); edit and delete with a confirm; search and filters (person, category, method, date range); month calendar showing each day's total with a heat-map tint; tap a day to open it.
- Store in SQLite with the Phase 1 permissions (members edit their own entries, owner edits all, viewers read).
- A combined "Total spending" number for the month that adds card statements and Daily entries without double-counting (a transfer that pays a card bill is not spending — add a "this is a card payment" flag that excludes it).
- Offline-capable: add entries offline and sync later without duplicates (client-generated ids).
ACCEPTANCE: add/edit/delete work on mobile width; totals match a hand calculation on a 10-entry sample; offline add then reconnect creates exactly one entry; a viewer cannot add.
```

---

## Prompt 4 — Slip capture from the iPhone

```
GOAL: Slip photos from the iPhone become Daily-ledger entries after I review them.
FACTS: A PWA cannot receive share-sheet items on iOS (no Web Share Target in Safari) and Shortcuts has no "new photo" trigger, so use these three routes. Never use the Web Share Target route.
BUILD:
1. Endpoint POST /api/slips, authenticated by a per-user revocable API token (create, show once, revoke in Settings; store only a hash). Accept multipart form data with fields: text (raw text extracted on the phone), image (optional photo), and optional amount, merchant, date, time, reference, bank. Also accept JSON. Rate limit it, cap the image size, reject non-images, and dedupe by image hash and by reference + amount + date.
2. Light server-side parsing, no OCR and no outside API: from "text", extract amount, date/time (Thai and Buddhist-era years), merchant or recipient, and bank/PromptPay reference for the common Thai bank transfer slips and QR payment slips. Write unit tests using at least 5 realistic sample slip texts (invent them; no real data). Anything unparsed stays blank for the human to fill.
3. Every incoming slip goes to a "Review inbox" (not directly to the ledger): photo beside editable fields, a confidence flag, category picker, Confirm / Discard / Merge-with-existing. Confirming creates a Daily entry with source = slip and keeps the photo.
4. In-app upload: pick several photos at once from the library; for photos without text, they enter the inbox with empty fields.
5. Store images under /data/slips/<user>/ with thumbnails; serve them only to logged-in household members.
6. Write docs/ios-shortcut.md with two recipes and the exact action list: (a) Share Sheet shortcut: shared image → on-device text extraction action → Get Contents of URL (POST, Request Body = Form, fields text + image, header Authorization: Bearer <token>); (b) a daily Time-of-Day automation: Find Photos in the album "Slips" (recent) → same steps → then move or remove processed photos so they are not sent twice. Note that Shortcuts ignores a manually set Content-Type header, so rely on the Form body type. Mark steps I must verify on my own iPhone (action names can differ by iOS version).
ACCEPTANCE: curl with a token creates an inbox item; a bad token gets 401; the same slip sent twice creates one item; confirming moves it to the ledger exactly once; images are not publicly reachable.
```

---

## Prompt 5 — Family tracking and reports

```
GOAL: Turn the ledger plus card statements into a family spending monitor.
BUILD:
- Budgets: monthly budget per category, for the household and optionally per person; progress bars, an over-budget warning at 80% and 100%, and rollover off by default.
- Views: by person, by category, by day, a week view, and a month-over-month comparison with the top 5 changes; filter by shared/personal and by payment method (card vs non-card).
- Split and reimburse: mark an entry as paid for someone else, track who owes whom, mark as settled (reuse the existing reimbursed flag logic for cards).
- Recurring items: rent, subscriptions, utilities with due dates; show "due in N days" on the home screen and in the Daily tab.
- Reports: a monthly summary page (income, card spending, daily spending, budgets, top merchants) and CSV export of the filtered view.
- Net Free keeps its current definition (Income − Spend − Car Loan); add household and per-person variants but do not change the existing numbers.
ACCEPTANCE: numbers reconcile with the Daily tab and statements on a sample month; a member sees only what the sharing setting allows; every new screen works at 375px in Thai and English, light and dark.
```

---

## Prompt 6 — Backups and hardening

```
GOAL: Make the shared data safe to rely on.
BUILD: a nightly SQLite backup (use the online backup API, keep the last 14, store in /data/backups, plus a one-click "download backup" for the owner); an audit log of logins, role changes, token creation and deletes, viewable by the owner; a restore procedure in README; session and invite cleanup jobs; security headers on all responses (Content-Security-Policy suitable for the PWA, X-Content-Type-Options, Referrer-Policy); a check that no secrets appear in logs; and a short threat-model note listing what is and is not protected.
ACCEPTANCE: restore a backup into a fresh container and confirm the app opens with the same data; a deleted entry shows in the audit log.
```
