#!/usr/bin/env python3
"""List recent mail headers (date | from | subject) from every configured mailbox.

    inbox-scan.py [--days N]          default: last 7 days

Read-only (BODY.PEEK). Mailboxes come from config.json mail.mailboxes + .env.
Useful for finding the day's job-list email or eyeballing confirmations by hand.
"""
import datetime
import email
import imaplib
import os
import sys
from email.header import decode_header

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402


def dh(s):
    out = ''
    for part, enc in decode_header(s or ''):
        out += part.decode(enc or 'utf8', 'replace') if isinstance(part, bytes) else part
    return out


def main():
    if '-h' in sys.argv or '--help' in sys.argv:
        raise SystemExit(__doc__)
    days = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 7
    since = (datetime.date.today() - datetime.timedelta(days=days)).strftime('%d-%b-%Y')
    boxes = PC.mailboxes()
    if not boxes:
        raise SystemExit('inbox-scan: no mailbox credentials configured (config.json mail.mailboxes + .env)')
    for addr, pw in boxes:
        M = imaplib.IMAP4_SSL(PC.imap_host())
        M.login(addr, pw)
        M.select('"%s"' % PC.cfg('mail.folder', 'INBOX'), readonly=True)
        _, data = M.search(None, f'(SINCE "{since}")')
        print(f'# {addr.split("@")[0]}')
        for i in data[0].split():
            _, md = M.fetch(i, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
            msg = email.message_from_bytes(md[0][1])
            print(f"{dh(msg['Date'])[:31]} | {dh(msg['From'])[:55]} | {dh(msg['Subject'])[:80]}")
        M.logout()


if __name__ == '__main__':
    main()
