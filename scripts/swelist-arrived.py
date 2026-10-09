#!/usr/bin/env python3
"""Cheap poll: has today's job-list email arrived and not yet been handed to an apply run?

    swelist-arrived.py            prints ARRIVED <YYYY-MM-DD> <subject> (exit 0) or NONE (exit 1)
    swelist-arrived.py --mark     record today as triggered, so later polls today print NONE

Read-only IMAP over every configured mailbox. The subject to look for is config
swelist.subject. Intended for a scheduled task that starts the day's apply run once the
list lands; `--mark` writes $PIPELINE_HOME/.swelist-triggered.
"""
import datetime
import email
import imaplib
import os
import sys
from email.header import decode_header

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

TRIG = PC.path('.swelist-triggered')
today = datetime.date.today()
if '-h' in sys.argv or '--help' in sys.argv:
    raise SystemExit(__doc__)
if '--mark' in sys.argv:
    os.makedirs(os.path.dirname(TRIG), exist_ok=True)
    open(TRIG, 'w').write(today.isoformat()); print('MARKED', today); sys.exit(0)
if os.path.exists(TRIG) and open(TRIG).read().strip() == today.isoformat():
    print('NONE (already triggered today)'); sys.exit(1)


def dh(s):
    return ''.join(p.decode(e or 'utf8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))


since = today.strftime('%d-%b-%Y')
subject = PC.cfg('swelist.subject', 'New Internships Posted Today')
for addr, pw in PC.mailboxes():
    M = imaplib.IMAP4_SSL(PC.imap_host()); M.login(addr, pw)
    M.select('"%s"' % PC.cfg('mail.folder', 'INBOX'), readonly=True)
    _, data = M.search(None, f'(SINCE "{since}" SUBJECT "{subject}")')
    for i in data[0].split():
        _, md = M.fetch(i, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])')
        msg = email.message_from_bytes(md[0][1])
        print('ARRIVED', today.isoformat(), dh(msg['Subject'])[:80]); M.logout(); sys.exit(0)
    M.logout()
print('NONE'); sys.exit(1)
