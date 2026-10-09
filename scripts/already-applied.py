#!/usr/bin/env python3
"""Pre-apply duplicate check: has the applicant already applied to this opening?

    python3 already-applied.py "<Company>" "<Role title>" [--key KEY8] [--req REQ_ID]

Checks every configured mailbox (config.json mail.mailboxes) for application confirmation
emails that mention the company, plus every prior ledger under $PIPELINE_HOME/runs for a
submitted row for the same company.

A company+role-title match is NOT unique: two distinct requisitions can carry
one title, and 6 of 12 keys in the August queue collided this way (Audax "Data Engineer
Co-op" 7f70a436 vs 451d266b, Honeywell, Stryker, Daktronics, Grant Thornton, Ontario
Teachers'). `duplicate` is a terminal outcome and the dedup then retires a REAL job forever,
silently. So a title match alone is no longer enough to call it a duplicate: pass --key
(the queue row's key8) and/or --req (the requisition id) and exit 3 is returned only when
the evidence NAMES THIS requisition. Otherwise the answer is exit 5, not exit 3.

Exit 0 = no evidence of a prior application (go ahead).
Exit 3 = CONFIRMED already applied -- the evidence names this exact req (key8 or req id)
         -> log `duplicate` and skip.
Exit 4 = the company has confirmations but none name this role -> go ahead, but note it.
Exit 5 = AMBIGUOUS -- the title matched but nothing ties it to THIS requisition
         -> log `review-duplicate` (requeueable), do not log `duplicate`.
"""
import imaplib, email, os, re, sys, glob
from email.header import decode_header

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

argv = sys.argv[1:]
key8 = req_id = ''
pos = []
i = 0
while i < len(argv):
    if argv[i] == '--key' and i + 1 < len(argv):
        key8 = argv[i + 1]; i += 2
    elif argv[i] == '--req' and i + 1 < len(argv):
        req_id = argv[i + 1]; i += 2
    else:
        pos.append(argv[i]); i += 1
if len(pos) < 2:
    raise SystemExit(__doc__)
company, role = pos[0], pos[1]

def norm(s):
    return re.sub(r'[^a-z0-9 ]+', ' ', (s or '').lower()).split()

STOP = {'intern', 'internship', 'summer', 'fall', 'spring', 'winter', 'co', 'op', 'the', 'and',
        'of', 'for', 'a', '2026', '2027', '2028', 'program', 'student', 'university', 'undergrad',
        'undergraduate', 'remote', 'hybrid', 'multiple', 'teams', 'team', 'in', 'to', 'us', 'usa'}
role_words = [w for w in norm(role) if w not in STOP and len(w) > 1]
co_words = [w for w in norm(company) if w not in {'inc', 'llc', 'corp', 'corporation', 'group', 'company', 'the', 'co'}]
co_key = ' '.join(co_words[:2]) or company.lower()

def role_match(text):
    t = set(norm(text))
    if not role_words:
        return False
    hit = sum(1 for w in role_words if w in t)
    need = len(role_words) if len(role_words) <= 4 else round(len(role_words) * 0.85)
    return hit >= max(1, need)

def dh(s):
    out = ''
    for part, enc in decode_header(s or ''):
        out += part.decode(enc or 'utf8', 'replace') if isinstance(part, bytes) else part
    return out

CONFIRM = r'(thank you for (applying|your (application|interest))|application (received|submitted|confirmation)|we (have )?received your application|your application (for|to|has been))'
company_mail, role_mail = [], []
# Gmail's X-GM-RAW index can miss recent mail, so scan locally: fetch the
# headers + first 4KB of every message in the window in ONE batched FETCH (a few hundred messages),
# cached for 10 minutes so three parallel appliers don't hammer IMAP.
import json, time, datetime
CACHE = PC.path('.mailcache-%s.json')
def load_box(addr, pw, days):
    cf = CACHE % re.sub(r'[^A-Za-z0-9]+', '_', addr)
    try:
        c = json.load(open(cf))
        if time.time() - c['t'] < 600: return c['msgs']
    except Exception: pass
    M = imaplib.IMAP4_SSL(PC.imap_host()); M.login(addr, pw)
    M.select('"%s"' % PC.cfg('mail.folder', 'INBOX'), readonly=True)
    since = (datetime.date.today() - datetime.timedelta(days=days)).strftime('%d-%b-%Y')
    typ, data = M.search(None, f'(SINCE "{since}")')
    ids = data[0].split()
    # Two separate FETCHes so every returned tuple starts with its own sequence number. A combined
    # FETCH lets Gmail return BODY[TEXT] before the headers, which attached bodies to the wrong
    # subject (a job alert got another company's thank-you body).
    byseq = {}
    for k in range(0, len(ids), 200):
        chunk = b','.join(ids[k:k+200])
        typ, md = M.fetch(chunk, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
        for part in md:
            if isinstance(part, tuple):
                seq = part[0].split()[0]
                h = email.message_from_bytes(part[1])
                byseq[seq] = {'box': addr.split('@')[0], 'date': dh(h['Date'])[:16], 'subj': dh(h['Subject']), 'from': dh(h['From']), 'body': ''}
        typ, md = M.fetch(chunk, '(BODY.PEEK[TEXT]<0.4000>)')
        for part in md:
            if isinstance(part, tuple):
                seq = part[0].split()[0]
                if seq in byseq:
                    byseq[seq]['body'] = part[1].decode('utf8', 'replace')
    msgs = list(byseq.values())
    M.logout()
    try:
        os.makedirs(os.path.dirname(cf), exist_ok=True)
        json.dump({'t': time.time(), 'msgs': msgs}, open(cf, 'w'))
    except Exception: pass
    return msgs

for addr, pw in PC.mailboxes():
    try:
        for m in load_box(addr, pw, 60):
            body = re.sub(r'https?://\S+|<[^>]+>|\S+@\S+', ' ', m['body'])  # ESP links (e.g. klaviyo.com) are not the company
            text = m['subj'] + ' ' + m['from'] + ' ' + body
            if f' {co_key} ' not in ' ' + ' '.join(norm(text)) + ' ' or not re.search(CONFIRM, text, re.I):
                continue
            # A one-word company name is often an ordinary word, so a body-only hit is not evidence:
            # "Zip" once matched another company's confirmation through a zip code. A real
            # confirmation names the company in the subject or the sender, so for single-word
            # companies require it there; a body-only hit stays company-level (exit 4 = apply and
            # note it), never a role hit that could imply a duplicate.
            strong = f' {co_key} ' in ' ' + ' '.join(norm(m['subj'] + ' ' + m['from'])) + ' '
            line = f"{m['box']} | {m['date']} | {m['subj'][:90]}"
            if len(co_words) == 1 and not strong:
                company_mail.append(line + '  [weak: company named only in body, ignored for role match]')
                continue
            company_mail.append(line)
            if role_match(text):
                role_mail.append((line, text))
    except Exception as e:
        print(f'warn: mailbox {addr.split("@")[0]} check failed: {e}', file=sys.stderr)

ledger_hits = []
for f in glob.glob(os.path.join(PC.runs_dir(), '*', 'ledger*.md')):
    for blk in re.split(r'\n(?=#{2,4} |\| )', open(f, encoding='utf8', errors='replace').read()):
        head = blk.split('\n', 1)[0]
        # Only a row whose OUTCOME is submitted counts; prose like "NOT submitted" or "submitted above" doesn't.
        if not (f' {co_key} ' in ' ' + ' '.join(norm(head)) + ' ' and role_match(head)):
            continue
        if re.search(r'outcome:\s*\**\s*submitted', blk, re.I) or re.search(r'\|\s*\**submitted\**\s*\|', head, re.I):
            ledger_hits.append((f"{os.path.relpath(f, PC.runs_dir())} | {head[:100]}", blk))

# A submitted ledger row carrying this posting's key8 is proof by itself, whatever
# the company spelling ("Asure" vs "Asure Software") or the table's column layout (an ATS column
# pushed `submitted` out of the 4th cell, so one posting was re-queued after it was submitted).
key_hits = []
if key8:
    for f in glob.glob(os.path.join(PC.runs_dir(), '*', 'ledger*.md')):
        for blk in re.split(r'\n(?=#{2,4} |\| )', open(f, encoding='utf8', errors='replace').read()):
            head = blk.split('\n', 1)[0]
            if key8.lower()[:8] in blk.lower() and (re.search(r'outcome:\s*\**\s*submitted', blk, re.I)
                                                    or re.search(r'\|\s*\**submitted\**\s*\|', head, re.I)):
                key_hits.append(f"{os.path.relpath(f, PC.runs_dir())} | {head[:100]}")

# A title match is not an identity match. Only evidence that names THIS requisition -- the
# queue row's key8 or the requisition id -- can justify the terminal `duplicate` outcome.
ident = [t.lower() for t in (key8, req_id) if t]

def names_this_req(text):
    t = ' ' + ' '.join(norm(text)) + ' '
    return any(f' {tok} ' in t for tok in (' '.join(norm(x)) for x in ident) if tok)

confirmed = [l for l, text in role_mail if names_this_req(text)] + \
            [l for l, blk in ledger_hits if names_this_req(blk)]

for l, _ in role_mail: print('MAIL  role match   :', l)
for l, _ in ledger_hits: print('LEDGER role match  :', l)
confirmed += key_hits
if confirmed:
    for l in confirmed: print('IDENTITY match     :', l)
    print('RESULT: ALREADY APPLIED (evidence names this req), skip and log `duplicate`')
    sys.exit(3)
if role_mail or ledger_hits:
    if not ident:
        print('NOTE: no --key/--req given, so this title match cannot be tied to this requisition.')
    else:
        print(f'NOTE: title matched but no evidence names {" / ".join(ident)}.')
    print('RESULT: AMBIGUOUS -- same title, unproven same req. Log `review-duplicate` '
          '(requeueable), NOT `duplicate`.')
    sys.exit(5)
for l in company_mail[:5]: print('MAIL  company only :', l)
if company_mail:
    print('RESULT: company confirmations exist but none name this role, so apply'); sys.exit(4)
print('RESULT: no prior application found, so apply'); sys.exit(0)
