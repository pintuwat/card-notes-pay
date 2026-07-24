# Gmail statement fetcher — setup (one time, ~5 min)

This reads `intuwat.fin@gmail.com` **on your Mac only**. Nothing is uploaded.
You create an OAuth credential once; after that it's just `python3 fetch_statements.py`.

## 1. Create the OAuth credential in Google Cloud Console

Log in to Google Cloud Console **with intuwat.fin@gmail.com**: https://console.cloud.google.com/

1. **New Project** (top bar) → name it e.g. `cardpay-gmail` → Create → make sure it's selected.
2. **Enable the Gmail API**
   - Menu → *APIs & Services* → *Library* → search **Gmail API** → **Enable**.
3. **OAuth consent screen** (*APIs & Services → OAuth consent screen*)
   - User type: **External** → Create.
   - App name: `cardpay-gmail`, user support email: your address, developer email: your address → Save and continue.
   - **Scopes**: skip (Save and continue).
   - **Test users**: **+ Add users** → add **intuwat.fin@gmail.com** → Save and continue.
   - Leave publishing status as **Testing** (fine for personal use).
4. **Create the credential** (*APIs & Services → Credentials*)
   - **+ Create credentials** → **OAuth client ID**.
   - Application type: **Desktop app** → name `cardpay-desktop` → Create.
   - Click **Download JSON**.

## 2. Drop the file here

Save that downloaded file as **exactly** this name and location:

```
/Users/pchaiintuwat/Documents/Claude_AI/Program/Mini_Project/CreditCard_Notes&Pay/sync-tool/credentials.json
```

## 3. Install libraries (one time)

```
cd "/Users/pchaiintuwat/Documents/Claude_AI/Program/Mini_Project/CreditCard_Notes&Pay/sync-tool"
pip3 install -r requirements.txt
```

## 4. Run it

```
python3 fetch_statements.py
```

- A browser window opens → sign in as **intuwat.fin@gmail.com** → you'll see
  *"Google hasn't verified this app"* (normal for Testing mode) →
  **Advanced → Go to cardpay-gmail (unsafe) → Continue → Allow**.
- It searches `subject:statement after:2026/01/01`, prints a summary of each email,
  and saves attachments into `./statements/`.

Then tell me what it printed and I'll build the per-bank transaction parser.

### Notes
- **token.json** appears after first login so you won't re-approve every run
  (in Testing mode it may expire after ~7 days — just rerun and re-approve).
- Read-only scope: the script can only **read** mail, never send or delete.
- `.gitignore` here blocks `credentials.json`, `token.json`, and `statements/`
  from ever being committed.
