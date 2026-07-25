#!/usr/bin/env python3
"""
Parse decrypted e-statement PDFs -> per card: monthly "Total Payment Due",
individual transactions, and installment plans. Builds cardpay-mydata.json
in the app's import format.

Passwords are DERIVED from your birthdate (env CARDPAY_DOB=DD/MM/YYYY); the
date itself is never stored.

Usage:  CARDPAY_DOB=23/05/1996 python3 parse_statements.py
"""
import os, re, json, glob, sys, base64
from pathlib import Path
from datetime import datetime
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
PDFS = HERE / "statements"
EMAILS = PDFS / "_emails.json"
_cfg = json.load(open(HERE / "config.json")) if (HERE / "config.json").exists() else {}

MONTHS = {m: i for i, m in enumerate(
    ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], 1)}
THMON = {"ม.ค":1,"ก.พ":2,"มี.ค":3,"เม.ย":4,"พ.ค":5,"มิ.ย":6,
         "ก.ค":7,"ส.ค":8,"ก.ย":9,"ต.ค":10,"พ.ย":11,"ธ.ค":12}
UOBMON = {"JAN":1,"FEB":2,"MAR":3,"APR":4,"MAY":5,"JUN":6,
           "JUL":7,"AUG":8,"SEP":9,"OCT":10,"NOV":11,"DEC":12}


def derive_passwords(dob):
    d = datetime.strptime(dob, "%d/%m/%Y")
    dd, mmm, yyyy = f"{d.day:02d}", d.strftime("%b"), f"{d.year}"
    return {"ktc": f"{dd}{mmm}{yyyy[2:]}", "kbank": f"{dd}{d.month:02d}{yyyy}",
            "cardx": f"{dd}{d.month:02d}{yyyy}", "ttb": f"{dd}{mmm}{yyyy}",
            "krungsri": f"{dd}{mmm}{yyyy}", "central": f"{dd}{mmm}{yyyy}",
            "uob": ""}


def clean(t): return (t or "").replace("ำา", "ำ")
def num(s): return round(float(s.replace(",", "")), 2)

try:
    import fitz  # PyMuPDF — decodes Krungsri/Central Thai fonts that pypdf garbles
except ImportError:
    fitz = None


def fix_thai(s):
    """Krungsri/Central fonts encode า as ำ, and real ำ as a doubled ำำ/ำา.
    Reverse it: collapse doubles back to ำ, then turn lone ำ into า."""
    return (s.replace("ำำ", "\x00").replace("ำา", "\x00")
             .replace("ำ", "า").replace("\x00", "ำ"))


DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{2}$")
AMT_RE = re.compile(r"^-?[\d,]+\.\d{2}$")
# Foreign-currency lines add a "CCY amount" pair before the real THB charge, e.g.
# "... BELCONNEN AUD 202.80 4,819.02" — the THB amount is always the LAST number on the
# line, so the optional foreign-currency pair is consumed but not captured.
UOB_TX = re.compile(r"^(\d{2} [A-Z]{3}) (\d{2} [A-Z]{3}) (.+?)(?: [A-Z]{3} [\d,]+\.\d{2})? ([\d,]+\.\d{2})( CR)?$", re.MULTILINE)


def read_fitz_lines(path, pw):
    if fitz is None:
        return None
    d = fitz.open(str(path))
    if d.needs_pass and not d.authenticate(pw):
        return None
    return [ln.strip() for p in d for ln in p.get_text().splitlines()]


def read_pdf(path, pw):
    r = PdfReader(str(path))
    if r.is_encrypted and str(r.decrypt(pw)) == "PasswordType.NOT_DECRYPTED":
        return None
    return clean("\n".join((p.extract_text() or "") for p in r.pages))


def ym_from_filename(fn):
    fl = fn.lower()
    m = re.search(r"(20\d\d)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", fl)
    if m: return f"{m.group(1)}-{MONTHS[m.group(2).title()]:02d}"
    m = re.search(r"(\d{2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(20\d\d)", fl)
    if m: return f"{m.group(3)}-{MONTHS[m.group(2).title()]:02d}"
    m = re.search(r"_(\d{2})(\d{2})(20\d\d)\b", fn)
    if m: return f"{m.group(3)}-{m.group(2)}"
    m = re.search(r"_(\d{2})(\d{2})(\d{2})\b", fn)
    if m: return f"20{m.group(1)}-{m.group(2)}"
    return None


def ym_from_date(s):
    """YYYY-MM from a dd/mm/yy or dd/mm/yyyy statement date."""
    m = re.search(r"\d{1,2}/(\d{2})/(\d{2,4})", s or "")
    if not m:
        return None
    yy = m.group(2)
    return f"{yy if len(yy) == 4 else '20' + yy}-{m.group(1)}"


def day(s):
    m = re.search(r"(\d{2})[/-]\d{2}[/-]\d{2,4}", s or "")
    return int(m.group(1)) if m else None


def mk_tx(date, desc, amount):
    desc = re.sub(r"\s+", " ", desc).strip()[:60]
    return {"date": date, "desc": desc, "amount": amount}


# ---------------- statement parsers (return list of card dicts) ----------------
TX_DDMMYY = re.compile(r"(\d{2}/\d{2}/\d{2})\s+\d{2}/\d{2}/\d{2}\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*$", re.M)
TX_DDMMYYYY = re.compile(r"(\d{2}/\d{2}/\d{4})\s+\d{2}/\d{2}/\d{4}\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*$", re.M)


def p_ktc(txt, fn):
    last4 = re.search(r"-(\d{4})\b", txt)
    last4 = last4.group(1) if last4 else "????"
    typ = re.search(r"TYPE OF CARD\s*:\s*(.+)", txt)
    typ = (typ.group(1).replace("CREDIT CARD", "").replace("CARD", "").strip().title()
           if typ else "KTC")
    close = re.search(r"วันสรุปยอดบัญชี\s*(\d{2}/\d{2}/\d{2})", txt)
    due = re.search(r"วันครบกำหนดชำระ\s*(\d{2}/\d{2}/\d{2})", txt)
    pay = re.search(r"ยอดที่ต้องชำระ/ชำระเกิน\D*?([\d,]+\.\d{2})", txt)
    tx = [mk_tx(d, ds, num(a)) for d, ds, a in TX_DDMMYY.findall(txt)
          if not re.search(r"x 16% x|365", ds)]
    return [dict(issuer="KTC", last4=last4, type=typ,
                 stmt=close.group(1) if close else "", due=due.group(1) if due else "",
                 amount=num(pay.group(1)) if pay else None, tx=tx)]


def p_kbank(txt, fn):
    stmt = re.search(r"STATEMENT DATE\s*(\d{2}/\d{2}/\d{4})", txt)
    due = re.search(r"DUE DATE\s*(\d{2}/\d{2}/\d{4})", txt)
    stmt = stmt.group(1) if stmt else ""; due = due.group(1) if due else ""
    bal = {}
    for m in re.finditer(r"(\d{4}) \d{2}XX XXXX (\d{4})\s+[A-Z.\s]+?\s+([\d,]+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})", txt):
        bal[m.group(2)] = num(m.group(4))
    out = []
    for blk in re.split(r"/ ACCOUNT DETAILS", txt)[1:]:
        hm = re.match(r"\s+(.+?)\s+(\d{4}) \d{2}XX XXXX (\d{4})", blk)
        if not hm:
            continue
        typ, last4 = hm.group(1).strip().title(), hm.group(3)
        seg = re.split(r"TOTAL BALANCE", blk)[0]
        tx = [mk_tx(d, ds, num(a)) for d, ds, a in TX_DDMMYY.findall(seg)]
        out.append(dict(issuer="KBANK", last4=last4, type=typ, stmt=stmt, due=due,
                        amount=bal.get(last4), tx=tx))
    return out


def p_cardx(txt, fn):
    last4 = re.search(r"5414 96XX XXXX (\d{4})", txt) or re.search(r"XXXX (\d{4})", txt)
    bal = re.search(r"([\d,]+\.\d{2})TOTAL BALANCE", txt)
    due = re.search(r"(\d{2}/\d{2}/\d{2,4}).{0,30}PAYMENT DUE", txt, re.S)
    # concatenated dates: "<desc> THA20/1221/12 496.00"
    tx = []
    for m in re.finditer(r"(.+?)\s*(\d{2}/\d{2})(\d{2}/\d{2})\s+(-?[\d,]+\.\d{2})", txt):
        desc = m.group(1).strip()
        if len(desc) < 3 or "XXXX" in desc:
            continue
        tx.append(mk_tx(m.group(2), desc, num(m.group(4))))
    return [dict(issuer="CardX", last4=last4.group(1) if last4 else "1834", type="UP2ME",
                 stmt="", due=due.group(1) if due else "",
                 amount=num(bal.group(1)) if bal else None, tx=tx)]


def p_ttb(txt, fn):
    m = re.search(r"(\d{4})-\d{2}XX-XXXX-(\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})", txt)
    last4 = m.group(2) if m else "5788"
    stmt = m.group(3) if m else ""; due = m.group(4) if m else ""
    g = (re.search(r"GRAND TOTAL\s+([\d,]+\.\d{2})", txt)
         or re.search(r"SUB TOTAL BALANCE\s+([\d,]+\.\d{2})", txt))
    tx = [mk_tx(d, ds, num(a)) for d, ds, a in TX_DDMMYYYY.findall(txt)]
    return [dict(issuer="ttb", last4=last4, type="", stmt=stmt, due=due,
                 amount=num(g.group(1)) if g else None, tx=tx)]


def p_krungsri_fitz(lines, brand):
    """Krungsri/Central via PyMuPDF: each field is on its own line
    ([transDate][postDate][description][amount]); Thai is normalized."""
    text = "\n".join(lines)
    last4 = re.search(r"(\d{4}) \d{2}XX XXXX (\d{4})", text)
    last4 = last4.group(2) if last4 else "????"

    amount = None
    for i, ln in enumerate(lines):
        if ("Total Payment Due For Credit Card" in ln or ln.startswith("SUBTOTAL FOR")) \
                and i + 1 < len(lines) and AMT_RE.match(lines[i + 1]):
            amount = num(lines[i + 1]); break

    dates = [ln for ln in lines if DATE_RE.match(ln)]
    stmt = dates[0] if dates else ""
    due = dates[1] if len(dates) > 1 else ""

    tx, i = [], 0
    while i < len(lines) - 3:
        if (DATE_RE.match(lines[i]) and DATE_RE.match(lines[i + 1])
                and not DATE_RE.match(lines[i + 2]) and not AMT_RE.match(lines[i + 2])
                and AMT_RE.match(lines[i + 3])):
            tx.append(mk_tx(lines[i], fix_thai(lines[i + 2]), num(lines[i + 3])))
            i += 4
        else:
            i += 1

    return [dict(issuer="Krungsri", last4=last4, type=brand, stmt=stmt, due=due,
                 amount=amount, tx=tx)]


# Placeholders so the router can name them; the loop handles Krungsri/Central via fitz.
def p_krungsri(txt, fn): return []
def p_central(txt, fn):  return []


# ---------------- UOB (unencrypted PDFs, multiple cards per statement) ----------------
def _uob_date(ds, stmt_year, stmt_mon):
    """'DD MON' → 'DD/MM/YY', handling Dec-in-Jan year wrap-around."""
    dd, mon = ds.split()
    mm = UOBMON[mon]
    yr = stmt_year - (1 if mm > stmt_mon + 3 else 0)
    return f"{dd}/{mm:02d}/{yr % 100:02d}"


def p_uob(txt, fn):
    sm = re.search(r"STATEMENT DATE (\d{1,2}) ([A-Z]{3}) (\d{4})", txt)
    if not sm:
        return []
    stmt_day, stmt_mon_str, stmt_year = int(sm.group(1)), sm.group(2), int(sm.group(3))
    stmt_mon = UOBMON[stmt_mon_str]
    stmt_str = f"{stmt_day:02d}/{stmt_mon:02d}/{stmt_year % 100:02d}"

    dm = re.search(r"PAYMENT DUE DATE (\d{1,2}) ([A-Z]{3}) (\d{4})", txt)
    due_str = (f"{int(dm.group(1)):02d}/{UOBMON[dm.group(2)]:02d}/{int(dm.group(3)) % 100:02d}"
               if dm else "")

    # Account summary: last4 → total balance (zero-balance cards are absent from this table)
    balances = {}
    for m in re.finditer(r"\d{4} \d{2}XX XXXX (\d{4}) ([\d,]+\.\d{2}) [\d,]+\.\d{2}", txt):
        balances[m.group(1)] = num(m.group(2))

    out = []
    for m in re.finditer(r"UOB ([A-Z/]+(?: [A-Z/]+)*)\n\d{4} \d{2}XX XXXX (\d{4})", txt):
        card_type = m.group(1).strip()
        last4 = m.group(2)
        balance = balances.get(last4)
        if not balance:
            continue
        sec_start = m.end()
        nxt = re.search(r"\nUOB [A-Z]", txt[sec_start:])
        sec = txt[sec_start: sec_start + (nxt.start() if nxt else len(txt))]

        tx = []
        for tm in UOB_TX.finditer(sec):
            desc = tm.group(3).strip()
            amount = num(tm.group(4))
            if tm.group(5):  # CR suffix = credit/refund → negative
                amount = -amount
            tx.append(mk_tx(_uob_date(tm.group(2), stmt_year, stmt_mon), desc, amount))

        out.append(dict(issuer="UOB", last4=last4, type=card_type,
                        stmt=stmt_str, due=due_str, amount=balance, tx=tx))
    return out


# ---------------- QR code extraction ----------------
def extract_qr(path, pw, issuer):
    """Extract payment QR image from statement PDF. Returns data-URL string or None."""
    if fitz is None:
        return None
    try:
        d = fitz.open(str(path))
        if d.needs_pass and not d.authenticate(pw):
            return None
        if issuer in ("krungsri", "central"):
            # Embedded 250×250 QR image on page 1 (second page)
            if len(d) < 2:
                return None
            for img in d[1].get_images():
                pix = fitz.Pixmap(d, img[0])
                if pix.width == 250 and pix.height == 250:
                    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode()
        elif issuer == "ktc":
            # Vector QR rendered in bottom-right corner of last page (payment slip)
            clip = fitz.Rect(532, 728, 595, 842)
            pix = d[-1].get_pixmap(matrix=fitz.Matrix(3, 3), clip=clip)
            return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode()
    except Exception:
        pass
    return None


# ---------------- ttb installment receipt (car loan) ----------------
def parse_ttb_receipt(txt):
    detail = re.search(r"ประเภทสินค้า\s*:?\s*([^\n]+?)\s+เลข", txt)
    total = re.search(r"จำนวนงวด\s*:?\s*(\d+)\s*งวด", txt)
    nxt = re.search(r"ค่างวดถัดไป\s+(\d+)\(([^)]+)\)\s*จาก\s*(\d+)\s*งวด\s+([\d,]+\.\d{2})", txt)
    payday = re.search(r"ชำระทุกวันที่\s*:?\s*(\d+)", txt)
    if not (nxt and total):
        return None
    next_no = int(nxt.group(1))
    th = re.match(r"\s*(\d{1,2})?\(?([฀-๿.]+)/(\d{2})", nxt.group(2))
    # month/year of NEXT installment, e.g. "ก.พ/69"
    mm = re.search(r"([฀-๿.]+)/(\d{2})", nxt.group(2))
    perm = num(nxt.group(4))
    tot = int(total.group(1))
    pd = int(payday.group(1)) if payday else 11
    start = ""
    if mm and mm.group(1) in THMON:
        nm = THMON[mm.group(1)]; ny = 2500 + int(mm.group(2)) - 543
        # next installment date -> back out to installment #1
        base = datetime(ny, nm, min(pd, 28))
        month0 = base.month - 1 - (next_no - 1)
        y = base.year + month0 // 12
        mo = month0 % 12 + 1
        start = f"{y}-{mo:02d}-{pd:02d}"
    return dict(detail=(detail.group(1).strip() if detail else "ttb auto loan"),
                perMonth=perm, totalMonths=tot, startDate=start)


# ---------------- routing ----------------
SENDER = [("kasikornbank.com", p_kbank, "kbank"), ("cardx.co.th", p_cardx, "cardx"),
          ("ttbbank.com", p_ttb, "ttb"), ("ktc.co.th", p_ktc, "ktc"),
          ("krungsri.com", p_krungsri, "krungsri"), ("centralthe1card.com", p_central, "central"),
          ("uob.co.th", p_uob, "uob"), ("uob.com", p_uob, "uob")]
FNAME = [("ktc", p_ktc, "ktc"), ("k-email", p_kbank, "kbank"), ("kbgc", p_kbank, "kbank"),
         ("cardx_e-statement", p_cardx, "cardx"), ("ttb_e-credit", p_ttb, "ttb"),
         ("uob_statement", p_uob, "uob"), ("uob_e-statement", p_uob, "uob")]
SKIP = ("interest_calculation", "bualuang", "mutual_fund", "krungthai", "innovestx",
        "e-ncb", "cardx_support")

# Subject keyword → (parser, pwkey). Checked when sender/filename routing misses.
SUBJECT_BANKS = [
    ("uob", p_uob, "uob"),
    ("kasikorn", p_kbank, "kbank"), ("kbank", p_kbank, "kbank"),
    ("ktc", p_ktc, "ktc"), ("krungthai card", p_ktc, "ktc"),
    ("cardx", p_cardx, "cardx"),
    ("ttb", p_ttb, "ttb"), ("tmb", p_ttb, "ttb"),
    ("krungsri", p_krungsri, "krungsri"),
    ("central the 1", p_central, "central"), ("central", p_central, "central"),
]

# PDF content signals → (parser, pwkey). Last-resort: try each password, detect from text.
CONTENT_BANKS = [
    (["united overseas bank", "uob premier", "uob visa", "uob platinum", "uob privi"], p_uob, "uob"),
    (["kasikornbank", "kasikorn bank"], p_kbank, "kbank"),
    (["krungthai card", "ktc visa", "ktc master", "ktc jcb"], p_ktc, "ktc"),
    (["cardx", "scb credit card", "5414 96xx"], p_cardx, "cardx"),
    (["tmbthanachart", "ttb credit card"], p_ttb, "ttb"),
    (["bank of ayudhya", "krungsri credit"], p_krungsri, "krungsri"),
    (["general card services", "central the 1 credit"], p_central, "central"),
]


def auto_detect_bank(path, PW):
    """Try all passwords; detect bank from PDF text. Returns (parser, pwkey) or (None, None)."""
    candidates = [("uob", "")] + [(k, v) for k, v in PW.items() if v]
    for pwkey, pw in candidates:
        txt = read_pdf(path, pw)
        if txt is None:
            continue
        tl = txt.lower()
        for signals, parser, key in CONTENT_BANKS:
            if any(sig in tl for sig in signals):
                return parser, key
    return None, None


def route(fn, sender, subject=""):
    fl = fn.lower()
    if "receipt_installment" in fl:
        return "ttb_receipt", "ttb"
    if any(s in fl for s in SKIP):
        return None, None
    s = (sender or "").lower()
    for dom, parser, pw in SENDER:
        if dom in s:
            return parser, pw
    for key, parser, pw in FNAME:
        if key in fl:
            return parser, pw
    subj = (subject or "").lower()
    for keyword, parser, pw in SUBJECT_BANKS:
        if keyword in subj:
            return parser, pw
    return None, None


def email_month(h):
    m = re.search(r"(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d\d)", h or "")
    return f"{m.group(3)}-{MONTHS[m.group(2)]:02d}" if m else None


def main():
    dob = os.environ.get("CARDPAY_DOB")
    if not dob:
        sys.exit("Set CARDPAY_DOB=DD/MM/YYYY")
    PW = derive_passwords(dob)
    att2date, att2from, att2subject = {}, {}, {}
    if EMAILS.exists():
        for r in json.load(open(EMAILS)):
            for a in r["attachments"]:
                att2date[a], att2from[a] = r["date"], r["from"]
                att2subject[a] = r.get("subject", "")

    records, ttb_receipts, skipped, card_qrs = [], [], [], {}
    for f in sorted(glob.glob(str(PDFS / "*.pdf")) + glob.glob(str(PDFS / "*.PDF"))):
        fn = os.path.basename(f)
        subj = att2subject.get(fn, "")
        parser, pwkey = route(fn, att2from.get(fn, ""), subj)
        if not parser:
            # Last resort: if subject or filename looks like any statement, probe content.
            if re.search(r"statement|e-statement|ใบแจ้งยอด", subj or fn, re.I):
                parser, pwkey = auto_detect_bank(f, PW)
        if not parser:
            skipped.append(fn); continue
        txt = read_pdf(f, PW.get(pwkey, ""))
        if txt is None:
            skipped.append(fn + " (decrypt failed)"); continue
        if parser == "ttb_receipt":
            r = parse_ttb_receipt(txt)
            if r: ttb_receipts.append(r)
            continue
        if pwkey in ("krungsri", "central"):
            lines = read_fitz_lines(f, PW.get(pwkey, ""))
            recs = p_krungsri_fitz(lines, "Central The 1" if pwkey == "central" else "") if lines else []
        else:
            recs = parser(txt, fn)
        file_qr = extract_qr(f, PW.get(pwkey, ""), pwkey)
        fallback = ym_from_filename(fn) or email_month(att2date.get(fn))
        for rec in recs:
            if rec["amount"] is None:
                skipped.append(fn + " (no amount)"); continue
            # Prefer the statement's own closing date (most accurate); else filename/email.
            rec["month"] = ym_from_date(rec.get("stmt")) or fallback
            rec["file"] = fn
            if file_qr:
                card_qrs[(rec["issuer"], rec["last4"])] = file_qr
            records.append(rec)

    # Dedup: one statement per (card, month) — the same statement can arrive twice
    # (e.g. a regular e-statement + a call-center copy). Keep the richer one.
    best = {}
    for r in records:
        k = (r["issuer"], r["last4"], r["month"])
        if k not in best or len(r["tx"]) > len(best[k]["tx"]):
            best[k] = r
    records = list(best.values())

    # ---- print verification ----
    records.sort(key=lambda r: (r["issuer"], r["last4"], r["month"] or ""))
    print(f"\n{'issuer':<10}{'last4':<7}{'month':<9}{'amount':>12}  #tx")
    print("-" * 48)
    for r in records:
        print(f"{r['issuer']:<10}{r['last4']:<7}{r['month'] or '?':<9}{r['amount']:>12,.2f}  {len(r['tx'])}")
    print(f"\n{len(records)} card-months, "
          f"{sum(len(r['tx']) for r in records)} transactions, "
          f"{len(ttb_receipts)} ttb-receipt(s)")

    # Load QR images from app QR folder (override any PDF-extracted ones)
    qr_folder = Path(os.path.expanduser(_cfg.get("app_dir", ""))) / "QR"
    if qr_folder.is_dir():
        last4_to_key = {r["last4"]: (r["issuer"], r["last4"]) for r in records}
        for qr_file in sorted(qr_folder.glob("*.png")) + sorted(qr_folder.glob("*.PNG")):
            m = re.search(r"-(\d{4})\.png$", qr_file.name, re.I)
            if not m:
                continue
            last4 = m.group(1)
            key = last4_to_key.get(last4)
            if not key:
                continue
            data = base64.b64encode(qr_file.read_bytes()).decode()
            card_qrs[key] = f"data:image/png;base64,{data}"
        print(f"[qr] loaded {len([k for k in card_qrs if card_qrs[k].startswith('data:')])} QR image(s) from {qr_folder}")

    build_import(records, ttb_receipts, card_qrs)
    if skipped:
        print("\nskipped:", len(skipped), "files (inserts / non-card / receipts handled separately)")


PALETTE = ["#6366f1","#ec4899","#14b8a6","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#84cc16","#f97316","#3b82f6","#a855f7","#10b981"]

# Friendly nicknames per card (keyed by last 4 digits). Card name = "Nickname ••last4".
NICKNAMES = {
    "0742": "Shopee",        # KBANK Shopee
    "3915": "KBank Passion", # KBANK The Passion
    "5788": "ttb",
    "1834": "SCB",           # CardX (SCB)
    "5389": "KTC Visa",
    "8789": "KTC Master",
    "3317": "KTC JCB",
    "6287": "KTC UnionPay",
    "7338": "Krungsri HomePro",
    "1289": "Central The 1",
    "1412": "UOB Premier",
    "4585": "UOB Premier 2",
    "9274": "UOB Platinum",
    "1111": "UOB Privi Miles",
}


def build_import(records, ttb_receipts, card_qrs=None):
    PAID_THROUGH = _cfg.get("paid_through", "2026-05")
    cards, order = {}, []
    for r in records:
        key = (r["issuer"], r["last4"])
        if key not in cards:
            nick = NICKNAMES.get(r["last4"], r["issuer"])
            nm = f"{nick} ••{r['last4']}"
            cards[key] = dict(id=len(cards) + 1, name=nm, bank=r["issuer"],
                              stmtDate=day(r["stmt"]), dueDate=day(r["due"]),
                              qr=(card_qrs or {}).get(key),
                              color=PALETTE[len(cards) % len(PALETTE)])
            order.append(key)
        else:
            c = cards[key]
            c["stmtDate"] = c["stmtDate"] or day(r["stmt"])
            c["dueDate"] = c["dueDate"] or day(r["due"])

    spending, transactions = [], []
    sid = tid = 1
    for r in records:
        cid = cards[(r["issuer"], r["last4"])]["id"]
        paid = bool(r["month"] and r["month"] <= PAID_THROUGH)
        spending.append(dict(id=sid, cardId=cid, month=r["month"], amount=r["amount"],
                             note="", paid=paid,
                             paidDate=f"{r['month']}-28T00:00:00.000Z" if paid else None))
        sid += 1
        for t in r["tx"]:
            transactions.append(dict(id=tid, cardId=cid, month=r["month"],
                                     date=t["date"], desc=t["desc"], amount=t["amount"]))
            tid += 1

    # ---- installments ----
    installments = []
    iid = 1
    # ttb car loan (use the receipt with the most progress / latest start)
    if ttb_receipts:
        best = sorted(ttb_receipts, key=lambda x: x.get("startDate") or "")[-1]
        installments.append(dict(id=iid, bank="ttb", detail=best["detail"],
                                 startDate=best["startDate"] or "2025-01-11",
                                 principal=round(best["perMonth"] * best["totalMonths"], 2),
                                 totalMonths=best["totalMonths"], interestRate=0,
                                 perMonth=best["perMonth"], manualPaid=None))
        iid += 1

    # Extract installments from transaction descriptions (NNN/MMM or NN/MM at end of desc)
    # e.g. "TOYOTA BUZZ CO.,LTD. BANGKOK 004/010"  or  "LAMLUKKA MAX SHOP : 03/06"
    INST_TX_RE = re.compile(r"^(.+?)\s+(?::\s*)?(\d{2,3})/(\d{2,3})$")
    # Collect (issuer, last4, merchant, totalM, startYM) → list of (currN, amount)
    tx_inst_groups = {}
    for r in records:
        if not r.get("month"):
            continue
        card_key = (r["issuer"], r["last4"])
        stmt_y, stmt_m = int(r["month"][:4]), int(r["month"][5:7])
        for t in r.get("tx", []):
            m = INST_TX_RE.match(t["desc"])
            if not m:
                continue
            merchant = m.group(1).strip()
            curr_n = int(m.group(2))
            total_m = int(m.group(3))
            amount = t["amount"]
            if not (1 <= curr_n <= total_m <= 120 and total_m >= 2 and amount > 0):
                continue
            # Compute implied start month
            sy, sm = stmt_y, stmt_m
            sm -= curr_n - 1
            while sm <= 0:
                sm += 12; sy -= 1
            start_ym = f"{sy}-{sm:02d}"
            sig = (card_key, merchant, total_m, start_ym)
            tx_inst_groups.setdefault(sig, []).append((curr_n, amount))

    for (card_key, merchant, total_m, start_ym), obs in sorted(tx_inst_groups.items()):
        obs.sort()
        per_month = obs[0][1]  # amount from the earliest month we observed
        issuer, last4 = card_key
        installments.append(dict(id=iid, bank=issuer,
                                 detail=merchant,
                                 startDate=f"{start_ym}-01",
                                 principal=round(per_month * total_m, 2),
                                 totalMonths=total_m, interestRate=0,
                                 perMonth=per_month, manualPaid=None))
        iid += 1

    out = dict(_app="CardNotesPay", _version=1, _exportedAt=datetime.utcnow().isoformat() + "Z",
               cards=[cards[k] for k in order], spending=spending,
               transactions=transactions, income=[], installments=installments,
               meta=[{"key": "seeded", "value": True}, {"key": "paidThrough2026-05", "value": True}])
    dest = Path(os.path.expanduser("~/Downloads/cardpay-mydata.json"))
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"[ok] wrote {dest}")
    print(f"     {len(out['cards'])} cards, {len(spending)} card-months, "
          f"{len(transactions)} transactions, {len(installments)} installments")


if __name__ == "__main__":
    main()
