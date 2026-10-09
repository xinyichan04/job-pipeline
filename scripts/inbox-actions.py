#!/usr/bin/env python3
"""
inbox-actions.py — find application emails that still need a click from us.

    inbox-actions.py                  last 14 days, every configured mailbox
    inbox-actions.py --days 30        widen the window
    inbox-actions.py --json           machine-readable

Why: "Additional information required ... to remain in consideration" emails once sat
unanswered for 11 days because nothing looked for them. Run this on every reconcile.

Lists ATS/recruiting emails whose subject or body asks for an action: confirm, verify,
additional information, complete your application, continue to apply, next step,
assessment invite. It prints the first action link and flags one-time sign-in codes
(Oracle "Confirm your identity", Workday "Verify your candidate account", "security
code") as CODE, because those are consumed while applying and are normally stale
afterwards. The caller decides: open ACTION links in a pipeline browser tab, match
each one to a ledger row, and record the outcome.

Reads every mailbox in config.json mail.mailboxes. Read-only (BODY.PEEK).
"""
import imaplib, email, os, re, socket, sys, json, datetime
from email.header import decode_header

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

ACTION_SUBJ = re.compile(
    r'additional information|information required|action required|complete your (application|profile)|'
    r'continue to apply|finish your application|incomplete application|next step|final step|'
    r'confirm your (email|application)|verify your (email|application)|please confirm|'
    r'assessment|invitation to|invited to|schedule|progressed to|next stage|video interview|interview', re.I)
CODE_SUBJ = re.compile(r'confirm your identity|verify your candidate account|security code|verification code|'
                       r'one-time|passcode', re.I)
# Senders that are never an ATS/recruiter action (newsletters, job boards). Extend as needed.
NOT_JOBS = re.compile(r'swelist|simplify\.jobs|glassdoor|linkedin\.com|indeed\.com|github', re.I)
LINK = re.compile(r'https?://[^\s"\'<>]+')
LINK_CUE = re.compile(r'apply|candidate|career|job|requisition|additional|info|confirm|verify|activate|'
                      r'assess|test|schedule|profile|task', re.I)

def dh(s):
    return ''.join(p.decode(c or 'utf8', 'replace') if isinstance(p, bytes) else p
                   for p, c in decode_header(s or ''))

def bodies(msg):
    raw = ''
    for part in msg.walk():
        if part.get_content_type() in ('text/plain', 'text/html'):
            try: raw += part.get_payload(decode=True).decode('utf8', 'replace')
            except Exception: pass
    return raw, re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', raw))

def main():
    socket.setdefaulttimeout(60)   # never hang forever on a dead IMAP socket
    a = sys.argv[1:]
    days = int(a[a.index('--days') + 1]) if '--days' in a else 14
    since = (datetime.date.today() - datetime.timedelta(days=days)).strftime('%d-%b-%Y')
    rows = []
    for addr, pw in PC.mailboxes():
        M = imaplib.IMAP4_SSL(PC.imap_host()); M.login(addr, pw)
        M.select('"%s"' % PC.cfg('mail.folder', 'INBOX'), readonly=True)
        _, d = M.search(None, f'(SINCE "{since}")')
        ids = d[0].split()
        # Headers in batches of 200 (one round trip each): per-message fetches over ~1-2k mails
        # have hung / dropped the IMAP connection.
        heads = []
        for k in range(0, len(ids), 200):
            _, hd = M.fetch(b','.join(ids[k:k + 200]), '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
            heads += [(part[0].split()[0], part[1]) for part in hd if isinstance(part, tuple)]
        for i, hb in heads:
            h = email.message_from_bytes(hb)
            subj, frm = dh(h['Subject']).replace('\n', ' '), dh(h['From'])
            if NOT_JOBS.search(frm): continue
            kind = 'CODE' if CODE_SUBJ.search(subj) else ('ACTION' if ACTION_SUBJ.search(subj) else None)
            if not kind: continue
            _, md = M.fetch(i, '(BODY.PEEK[])')
            raw, text = bodies(email.message_from_bytes(md[0][1]))
            link = next((u.replace('&amp;', '&') for u in LINK.findall(raw)
                         if LINK_CUE.search(u) and not re.search(r'unsubscribe|privacy|\.(png|jpe?g|gif|css)', u, re.I)), '')
            rows.append({'box': addr, 'date': (h['Date'] or '')[5:22], 'from': frm[:60],
                         'subject': subj[:140], 'kind': kind, 'snippet': text[:220], 'link': link})
        M.logout()
    if '--json' in a:
        print(json.dumps(rows, indent=1)); return
    for r in rows:
        print(f"{r['kind']:6} {r['date']} | {r['box'].split('@')[0]} | {r['from'][:35]} | {r['subject'][:90]}")
        if r['kind'] == 'ACTION': print(f"       link: {r['link'][:140]}")
    print(f"-- {sum(r['kind']=='ACTION' for r in rows)} action, {sum(r['kind']=='CODE' for r in rows)} code emails in {days} days")

if __name__ == '__main__':
    main()
