#!/usr/bin/env python3
"""
inbox-code.py — pull a one-time verification / security code (or verify link) out of the mailbox.

    inbox-code.py                     newest code from any sender, last 30 min
    inbox-code.py --from maven        only mails whose sender, subject OR body names "maven"
    inbox-code.py --from "bny|oracle" alternatives, any one may match
    inbox-code.py --wait 240          poll up to 240s for one to arrive (5s cadence, then 10s)
    inbox-code.py --minutes 60        widen the lookback window
    inbox-code.py --since 1790000000  only mails received at/after this moment
                                      (epoch seconds or ISO-8601, e.g. 2026-09-26T16:17:00Z)
    inbox-code.py --since T1 --until T2   replay a past window (debugging a miss)
    inbox-code.py --link --from toro  print an account-activation / verify / reset LINK
                                      instead of a code (Workday "Verify your candidate
                                      account" mails come from <tenant>@otp.workday.com)

stdout is ONLY the code / link, or "NO CODE" / "NO LINK", so an applier can capture it with
$(...). stderr carries one "# match:" line naming the sender, subject and receive time of the
mail the code came from — CHECK IT names the company you are applying to — plus hints when
nothing matched (other code mails in the window, "this mail has a link, use --link", ...).

Exit: 0 found · 1 nothing found · 2 no mailbox could be reached (DNS / network / login) — that
is NOT "the company never sent it"; rerun once the network is back.

What it searches: every configured mailbox in order (config.json mail.mailboxes; the first
one should be the address you put on application forms), in mail.folder plus
mail.extra_folders (Gmail default: [Gmail]/All Mail, i.e. every label incl. Inbox/Updates/
Promotions/archived, plus [Gmail]/Spam and [Gmail]/Trash), by the server receive time
(INTERNALDATE), read or unread, newest first.

--from matches sender name/address, subject and body text, ignoring case, spaces and
punctuation ("williamblair" matches "William Blair", "otp.workday" matches otp.workday.com).
ATS words expand to that ATS's mail fingerprint: "oracle" also matches branded Oracle
Recruiting mails ("Confirm your identity" from people.bny.com, csx.com, ul.com ...),
"greenhouse"/"grnh", "workday", "successfactors", "icims", "clinch".

Run it in the FOREGROUND with a Bash timeout above --wait (e.g. timeout: 300000 for
--wait 240): a poll the tool moves to the background never reports back to you.
"""
import imaplib, email, os, re, sys, time, datetime, socket, html as _html
from email.header import decode_header

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

IMAP_TIMEOUT = 25          # seconds per socket op — an unset timeout once hung for 10+ min
FOLDERS = tuple('"%s"' % f for f in [PC.cfg('mail.folder', 'INBOX')] + list(PC.cfg('mail.extra_folders', []) or []))


def cfg():
    """Every mailbox we hold credentials for, in priority order (first = form address)."""
    boxes = PC.mailboxes()
    if not boxes:
        raise SystemExit('inbox-code: no mailbox credentials configured (config.json mail.mailboxes + .env)')
    return boxes


def dh(s):
    out = ''
    for p, e in decode_header(s or ''):
        if isinstance(p, bytes):
            try:
                out += p.decode(e or 'utf8', 'replace')
            except LookupError:
                out += p.decode('utf8', 'replace')
        else:
            out += p
    return re.sub(r'\s*\n\s*', ' ', out)


# ---------------------------------------------------------------- body decoding

def _parts(msg):
    """Decoded (content_type, text) for every text/plain and text/html part (QP/base64 undone)."""
    out = []
    for part in msg.walk():
        ct = part.get_content_type()
        if ct not in ('text/plain', 'text/html'):
            continue
        try:
            raw = part.get_payload(decode=True) or b''
        except Exception:
            continue
        cs = part.get_content_charset() or 'utf-8'
        try:
            txt = raw.decode(cs, 'replace')
        except LookupError:
            txt = raw.decode('utf-8', 'replace')
        out.append((ct, txt))
    return out


def html_to_text(h):
    h = re.sub(r'(?is)<(style|script|head|title)\b[^>]*>.*?</\1\s*>', ' ', h)
    h = re.sub(r'(?is)<!--.*?-->', ' ', h)
    h = re.sub(r'(?i)<br\s*/?>|</?(p|div|tr|td|th|table|h[1-6]|li|ul|ol|center|section)\b[^>]*>', '\n', h)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = _html.unescape(h)
    return h


def body(msg):
    """Plain-text view of the whole mail: text/plain parts plus de-tagged, entity-decoded HTML."""
    chunks = []
    for ct, txt in _parts(msg):
        chunks.append(html_to_text(txt) if ct == 'text/html' else txt)
    t = '\n'.join(chunks)
    t = t.replace('\xa0', ' ').replace('​', '').replace('Â', ' ')
    t = re.sub(r'[ \t\r\f\v]+', ' ', t)
    t = re.sub(r' *\n[ \n]*', '\n', t)
    return t


def raw_body(msg):
    return ' '.join(txt for _, txt in _parts(msg))


# ---------------------------------------------------------------- code extraction
#
# Shapes seen in real verification mails:
#   Greenhouse   "...security code field on your application:\n tbXiwaX0"  (8 mixed-case, may be letters only)
#   Oracle ORC   "one-time pass code : 123456" / "using this code: 123456." (BNY, CSX, TI, UL, Vertiv ...)
#   ByteDance    subject "ByteDance verification code: 123456"; body "code is\n 123456"
#   SuccessFact. "Your passcode for account verification is 123456"
#   Amex (ORC)   "one-time passcode below:\n 123456"
#   Waymo/Clinch "Here is the code required to complete your form ...\n ABC12\n-----"  (5 upper alnum)
#   GitHub/misc  8 digits; IBM "V1234-123456"
CUE = re.compile(r'(?i)(?<![a-z])(?:code|passcode|pass\s+code|pass\s?word|otp|pin)\b')

_STOP = {w.lower() for w in '''security verification greenhouse workday application
resubmit complete below field code passcode expires expire minutes please enter hello dear
thanks regards note your this that with from have here form the verify account confirm identity
candidate career careers website required sincerely team using valid only once login sign
use following continue after before click link email mail submit'''.split()}
_STOP.add('password')   # the word itself is never a code


def _code_like(tok, standalone=False):
    """Could `tok` be a verification code? `standalone` = it sits alone on its own line."""
    if not tok or tok.lower() in _STOP:
        return False
    core = tok.replace('-', '')
    if not core.isalnum() or not core.isascii():
        return False
    n = len(core)
    if core.isdigit():
        if not 4 <= n <= 8:
            return False
        if n == 4 and re.match(r'(19|20)\d\d$', core):      # a year, not a code
            return False
        return True
    if not 4 <= n <= 12:
        return False
    has_d = any(c.isdigit() for c in core)
    ups = sum(c.isupper() for c in core)
    lows = sum(c.islower() for c in core)
    if has_d:
        return True
    # letters only: accept ALL-CAPS (Waymo) or genuinely mixed case (Greenhouse "YSuHzlAh"),
    # never ordinary words ("Please", "hello") — and only when standing alone or after a colon.
    if ups == n and n >= 5:
        return True
    if ups >= 2 and lows >= 1 and not (ups == 1 and core[0].isupper()):
        return True
    return False


_TOKEN = r'([A-Za-z0-9]{2,10}(?:-[A-Za-z0-9]{2,10})?|[A-Za-z0-9]{4,12})'
_SUBJ_RXS = [
    re.compile(r'(?i)(?:code|passcode|otp|pin)\s*(?:is|:)\s*' + _TOKEN + r'\b'),
    re.compile(r'(?i)\b(?:use|enter)\s+' + _TOKEN + r'\s+(?:to|as)\b'),
    re.compile(r'(?i)^\s*' + _TOKEN + r'\s+is\s+your\b'),
    re.compile(r'(?i)\b(?:code|passcode)\s+' + _TOKEN + r'\s+(?:to|as|for)\b'),
]


def extract_code(text, subject=False):
    """Best verification code in `text`, case preserved (Greenhouse codes are case-sensitive)."""
    if not text:
        return None
    if subject:
        for rx in _SUBJ_RXS:
            m = rx.search(text)
            if m and _code_like(m.group(1)):
                return m.group(1)
        return None
    for cue in CUE.finditer(text):
        after = text[cue.end():cue.end() + 260]
        # 1. "code: X" / "code : X" / "code is X" on the same line or the next ones
        m = re.match(r'[^\n:]{0,110}?(?::|\bis\b)\s*' + _TOKEN + r'(?=[\s.,;)!]|$)', after)
        if m and _code_like(m.group(1)):
            return m.group(1)
        # 2. the code alone on one of the next few lines (Waymo, Greenhouse, Amex, ByteDance)
        lines = after.split('\n')[1:5]
        for ln in lines:
            s = ln.strip().strip('.')
            if re.fullmatch(_TOKEN, s) and _code_like(s, standalone=True):
                return s
    # 3. last resort: a 6-8 digit number shortly after any cue word
    for cue in CUE.finditer(text):
        m = re.search(r'(?<![\d-])(\d{6,8})(?![\d-])', text[cue.end():cue.end() + 160])
        if m:
            return m.group(1)
    return None


def code_of(msg):
    return extract_code(dh(msg['Subject']), subject=True) or extract_code(body(msg))


# ---------------------------------------------------------------- link extraction

LINK_RX = re.compile(r'https?://[^\s"\'<>]+')
LINK_GOOD = re.compile(r'/activate/|/pass\s?wordreset/|reset-?pass\s?word|verify|confirm|activation|magic|signin|sign-in', re.I)
LINK_WEAK = re.compile(r'token', re.I)
LINK_BAD = re.compile(r'unsubscribe|privacy|/image/|myworkdaycdn|\.(png|jpe?g|gif|svg|css)(\?|$)|'
                      r'facebook|twitter|linkedin\.com|instagram|youtube', re.I)


def extract_link(msg):
    best, score = None, 0
    for u in LINK_RX.findall(raw_body(msg)):
        u = _html.unescape(u).rstrip('.,);')
        if LINK_BAD.search(u):
            continue
        s = 2 if LINK_GOOD.search(u) else (1 if LINK_WEAK.search(u) else 0)
        if s > score:
            best, score = u, s
    return best


# ---------------------------------------------------------------- sender / company filter

ALIASES = {
    'oracle': ['oraclecloud', 'confirm your identity', 'one-time pass code', 'candidate self service'],
    'oraclecloud': ['confirm your identity', 'one-time pass code'],
    'greenhouse': ['greenhouse-mail.io', 'security code for your application'],
    'grnh': ['greenhouse-mail.io', 'security code for your application'],
    'workday': ['otp.workday.com', 'myworkday', 'verify your candidate account'],
    'successfactors': ['one-time password for candidate account', 'ns2cloud', 'successfactors'],
    'sf': ['one-time password for candidate account', 'ns2cloud'],
    'icims': ['icims'],
    'clinch': ['clinchtalent'],
    'waymo': ['clinchtalent'],
}


def _norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def _needles(sender_filter):
    alts = [a.strip() for a in re.split(r'[|,]', sender_filter or '') if a.strip()]
    out = []
    for a in alts:
        out.append(a)
        out += ALIASES.get(_norm(a), [])
    return [n for n in out if _norm(n)]


def _body_rx(needle):
    chars = _norm(needle)
    return re.compile(r'(?i)(?<![a-z0-9])' + r'[\W_]{0,2}'.join(map(re.escape, chars)) + r'(?![a-z0-9])')


def header_matches(needles, frm, sub):
    hay = _norm(frm + ' ' + sub)
    return any(_norm(n) in hay for n in needles)


def body_matches(needles, text):
    return any(_body_rx(n).search(text) for n in needles)


# ---------------------------------------------------------------- IMAP

def _connect(addr, pw):
    M = imaplib.IMAP4_SSL(PC.imap_host(), timeout=IMAP_TIMEOUT)
    M.login(addr, pw)
    return M


class Box:
    def __init__(self, addr, pw):
        self.addr, self.pw, self.M = addr, pw, None
        self.cache = {}                                   # (folder, uid) -> Message

    def close(self):
        try:
            if self.M:
                self.M.logout()
        except Exception:
            pass
        self.M = None

    def recent(self, cutoff):
        """[(internaldate, folder, uid, from, subject)] received at/after `cutoff`, all folders."""
        if self.M is None:
            self.M = _connect(self.addr, self.pw)
        since = (cutoff - datetime.timedelta(days=1)).strftime('%d-%b-%Y')
        out = []
        for f in FOLDERS:
            typ, _ = self.M.select(f, readonly=True)
            if typ != 'OK':
                continue
            crit = f'SINCE "{since}"'
            if MODE.get('until'):
                crit += (MODE['until'] + datetime.timedelta(days=1)).strftime(' BEFORE "%d-%b-%Y"')
            typ, data = self.M.uid('search', None, f'({crit})')
            uids = data[0].split() if data and data[0] else []
            if not uids:
                continue
            uids = uids[-400:]
            typ, md = self.M.uid('fetch', b','.join(uids),
                                 '(INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])')
            for item in md or []:
                if not isinstance(item, tuple):
                    continue
                meta = item[0].decode('utf8', 'replace')
                mu = re.search(r'UID (\d+)', meta)
                mi = re.search(r'INTERNALDATE "([^"]+)"', meta)
                if not (mu and mi):
                    continue
                try:
                    idt = datetime.datetime.strptime(mi.group(1), '%d-%b-%Y %H:%M:%S %z')
                except ValueError:
                    continue
                if idt < cutoff:
                    continue
                h = email.message_from_bytes(item[1])
                out.append((idt, f, mu.group(1), dh(h['From']), dh(h['Subject'])))
        return out

    def message(self, folder, uid):
        key = (folder, uid)
        if key not in self.cache:
            self.M.select(folder, readonly=True)
            typ, md = self.M.uid('fetch', uid, '(BODY.PEEK[])')
            raw = next((it[1] for it in md or [] if isinstance(it, tuple)), b'')
            self.cache[key] = email.message_from_bytes(raw)
        return self.cache[key]


MODE = {'link': False, 'until': None}   # until: replay/debug upper bound (--until)


def _say(*a):
    print(*a, file=sys.stderr)


def scan(boxes, sender_filter, cutoff, report_misses=False):
    """One pass over every mailbox. Returns (value, reachable_count)."""
    needles = _needles(sender_filter)
    reachable = 0
    cands = []
    for b in boxes:
        try:
            for r in b.recent(cutoff):
                cands.append((r, b))
            reachable += 1
        except Exception as e:
            _say(f'# {b.addr}: IMAP error: {e}')
            b.close()
    if MODE.get('until'):
        cands = [c for c in cands if c[0][0] <= MODE['until']]
    cands.sort(key=lambda x: x[0][0], reverse=True)       # newest first, across boxes/folders
    others, hinted = [], set()
    for (idt, folder, uid, frm, sub), b in cands:
        try:
            msg = None
            if needles and not header_matches(needles, frm, sub):
                msg = b.message(folder, uid)
                if not body_matches(needles, body(msg)[:6000]):
                    if report_misses:
                        others.append((idt, frm, sub, b, folder, uid))
                    continue
            msg = msg or b.message(folder, uid)
            val = extract_link(msg) if MODE['link'] else code_of(msg)
            if val:
                sub = sub.replace(val, '<code>')              # never echo the code twice into logs
                _say(f'# match: {frm[:70]} | {sub[:80]} | {idt.astimezone(datetime.timezone.utc):%Y-%m-%d %H:%M:%SZ}'
                     f' | {b.addr.split("@")[0]} {folder.strip(chr(34))}')
                return val, reachable
            if report_misses and not MODE['link'] and sub not in hinted and extract_link(msg) and re.search(
                    r'(?i)verify|activate|reset', sub):
                hinted.add(sub)
                _say(f'# hint: "{sub[:60]}" from {frm[:50]} has a verify/reset LINK, not a code — rerun with --link')
        except Exception as e:
            _say(f'# {b.addr}: fetch error: {e}')
            b.close()
    if report_misses and needles:
        shown = 0
        for idt, frm, sub, b, folder, uid in others:
            try:
                m = b.message(folder, uid)
                v = extract_link(m) if MODE['link'] else code_of(m)
            except Exception:
                v = None
            if v:
                if not shown:
                    _say(f'# no mail matched --from {sender_filter!r}; other {"link" if MODE["link"] else "code"} mails in the window:')
                _say(f'#   {idt.astimezone(datetime.timezone.utc):%H:%M:%SZ} | {frm[:60]} | '
                     f'{re.sub(r"[0-9]{4,8}", "<n>", sub.replace(v, "<code>"))[:70]}')
                shown += 1
                if shown >= 5:
                    break
    return None, reachable


def _parse_since(s):
    if re.fullmatch(r'\d{9,11}(\.\d+)?', s):
        return datetime.datetime.fromtimestamp(float(s), datetime.timezone.utc)
    d = datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
    if d.tzinfo is None:
        d = d.astimezone()                                   # local time
    return d


def main(a):
    def opt(name, default=None):
        return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default
    if '-h' in a or '--help' in a:
        print(__doc__)
        return 0
    sender = opt('--from')
    minutes = float(opt('--minutes', 30))
    wait = float(opt('--wait', 0))
    MODE['link'] = '--link' in a
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(minutes=minutes)
    if opt('--since'):
        cutoff = _parse_since(opt('--since'))
    if opt('--until'):
        MODE['until'] = _parse_since(opt('--until'))
    boxes = [Box(ad, pw) for ad, pw in cfg()]
    start = time.time()
    deadline = start + wait
    ever_reached = False
    try:
        while True:
            last = time.time() >= deadline
            val, reached = scan(boxes, sender, cutoff, report_misses=last)
            ever_reached = ever_reached or reached > 0
            if val:
                print(val)
                return 0
            if last:
                break
            elapsed = time.time() - start
            time.sleep(min(5 if elapsed < 60 else 10, max(0.0, deadline - time.time())))
    finally:
        for b in boxes:
            b.close()
    print('NO LINK' if MODE['link'] else 'NO CODE')
    if not ever_reached:
        _say('# no mailbox was reachable for the whole wait (network/DNS/login) — this is NOT '
             '"no email was sent"; fix the network and rerun')
        return 2
    return 1


if __name__ == '__main__':
    socket.setdefaulttimeout(IMAP_TIMEOUT)
    sys.exit(main(sys.argv[1:]))
