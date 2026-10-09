#!/usr/bin/env python3
"""Job-list daily digest - the top-N companies from each SWE List email.

When a SWE List (simplify.jobs) daily email arrives, pull every company on it and send the
operator the N that are most widely known or where the applicant has the best chance,
with every eligible posting link at each of them.

Deterministic, no LLM: IMAP -> parse rows -> fetch-jds.py (Simplify structured fields) ->
prescreen.py rules -> score -> notify() (NOTIFY_CMD). Emails are tracked by subject+date in
$PIPELINE_HOME/swelist-digest/seen.json, so running it often is cheap and idempotent.

Usage:
    swelist-digest.py                 # process every unseen list email, notify each
    swelist-digest.py --dry-run       # process unseen emails, print digest, send nothing, mark nothing
    swelist-digest.py --since 12-Sep-2026 --dry-run   # override IMAP search window
    swelist-digest.py --seed          # mark all current list emails seen, send nothing
    swelist-digest.py --dry-run --since D --record-top10   # replay, write TOP10.json, send nothing

Config: swelist.sender / swelist.top_n / swelist.lookback_days, eligibility.* (see
config.example.json). Exit 0 always on "nothing new"; prints NO_NEW_EMAIL so a scheduled
caller can stay quiet.
"""
import datetime as dt
import email
import email.utils
import html as htmllib
import imaplib
import json
import os
import re
import subprocess
import sys
from email.header import decode_header

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prescreen  # noqa: E402  (degree / term / active rules, single source of truth)

import pipeline_config as PC  # noqa: E402

STATE_DIR = PC.path("swelist-digest")
STATE = os.path.join(STATE_DIR, "seen.json")
SENDER = PC.cfg("swelist.sender", "noreply@swelist.com")
TOP_N = int(PC.cfg("swelist.top_n", 10))
LOOKBACK_DAYS = int(PC.cfg("swelist.lookback_days", 3))

# Name recognition tiers — edit freely. Lowercase, punctuation-normalised.
# 3 = household-name tech / top quant, 2 = widely known.
FAME_MAP = {}
FAME_NAMES = {
    3: ["google", "alphabet", "deepmind", "apple", "meta", "facebook", "amazon", "aws",
        "microsoft", "netflix", "nvidia", "openai", "anthropic", "tesla", "jane street",
        "citadel", "citadel securities", "two sigma", "hudson river trading", "d e shaw",
        "de shaw", "jump trading", "optiver", "imc", "imc trading", "stripe", "databricks",
        "bloomberg", "linkedin", "uber", "airbnb"],
    2: ["qualcomm", "amd", "intel", "ibm", "oracle", "salesforce", "adobe", "snap",
        "snapchat", "pinterest", "cisco", "goldman sachs", "jpmorgan", "jpmorgan chase",
        "morgan stanley", "capital one", "palantir", "roblox", "coinbase", "robinhood",
        "doordash", "lyft", "spotify", "dropbox", "figma", "notion", "ramp", "plaid",
        "scale ai", "cloudflare", "datadog", "snowflake", "mongodb", "atlassian", "shopify",
        "twitch", "reddit", "discord", "duolingo", "instacart", "block", "square", "paypal",
        "visa", "mastercard", "intuit", "vmware", "broadcom", "arm", "micron",
        "texas instruments", "samsung", "tiktok", "bytedance", "yelp", "zillow",
        "expedia", "wayfair", "hubspot", "twilio", "okta", "workday", "servicenow",
        "splunk", "akuna capital", "sig", "susquehanna", "virtu", "drw",
        "tower research capital", "five rings", "old mission", "point72", "millennium",
        "bridgewater", "blackrock", "fidelity", "john deere", "caterpillar", "boeing",
        "ge", "general motors", "ford", "rivian", "waymo", "zoox", "aurora", "nuro",
        "pure storage", "nutanix", "juniper networks", "arista networks", "autodesk",
        "electronic arts", "activision", "blizzard", "epic games", "riot games", "unity",
        "cerebras", "klaviyo", "axon", "qualtrics", "chime", "affirm", "brex", "asana",
        "grammarly", "didi global", "dv trading", "ibotta", "commure", "newsbreak"],
}
for tier, names in FAME_NAMES.items():
    for n in names:
        FAME_MAP.setdefault(n, tier)

# Companies the applicant is verified ineligible at, company-wide: {"name": "reason"}.
COMPANY_INELIGIBLE = {norm_k.lower(): v for norm_k, v in
                      (PC.cfg("eligibility.ineligible_companies", {}) or {}).items()
                      if not norm_k.startswith("_") and norm_k != "example corp"}
# Defense / ITAR-heavy employers (often require US persons). Blocks only when
# eligibility.block_defense_itar is true; otherwise the digest just notes it.
ITAR_COMPANIES = {c.lower() for c in (PC.cfg("eligibility.defense_itar_companies", []) or [])}
BLOCK_ITAR = bool(PC.cfg("eligibility.block_defense_itar", False))
BLOCK_CLEARANCE = bool(PC.cfg("eligibility.block_clearance_required", True))

def itar_match(comp):
    """True if `comp` (already norm()'d) names a defense/ITAR employer.

    Was `comp in ITAR_COMPANIES`, i.e. EXACT set membership — which silently failed for every
    company whose feed name is not byte-identical to the list entry: "Booz Allen" missed the
    entry "booz allen hamilton" and reached the apply queue, and "L3Harris Technologies" missed
    "l3harris". For an applicant who cannot hold a clearance a miss costs a wasted application.

    Matching rule: compare TOKEN PREFIXES in whichever direction is shorter, so the list entry
    and the feed name only have to agree on their leading words. A single-token key must match
    the company's first token exactly. Deliberately biased toward over-blocking: wrongly skipping
    one posting is far cheaper than applying to a defense contractor you are ineligible for.
    (Known consequence: an unrelated firm sharing a leading token — e.g. SAIC Motor vs SAIC —
    would be blocked. Accepted.)
    """
    ct = comp.split()
    if not ct:
        return False
    for k in ITAR_COMPANIES:
        kt = k.split()
        if len(kt) == 1:
            if ct[0] == kt[0]:
                return True
        else:
            n = min(len(ct), len(kt))
            if n >= 2 and ct[:n] == kt[:n]:
                return True
    return False


TECH_ROLE = re.compile(r"software|swe\b|developer|engineer|machine learning|\bml\b|\bai\b|"
                       r"data|computer science|full.?stack|backend|front.?end|platform|"
                       r"infrastructure|systems|compiler|quant|research|security|cloud|"
                       r"devops|mobile|ios|android|robotics|embedded", re.I)
NON_TECH = re.compile(r"marketing|sales|finance intern|accounting|human resources|\bhr\b|"
                      r"legal|commodity trading analyst|business transformation|"
                      r"product management|recruit|communications|supply chain|"
                      r"mechanical|electrical|electronics|packaging|civil|chemical", re.I)
CLEARANCE = re.compile(r"security clearance|secret clearance|top secret|\bitar\b|"
                       r"u\.?s\.? citizen(ship)? (is )?required|"
                       r"must be a u\.?s\.? citizen", re.I)
# Export-control boilerplate (e.g. Qualcomm) means a licence *may* be needed for some
# citizenships, China often among them. A warning, not a disqualification.
EXPORT = re.compile(r"export.control|export licen[cs]e|\bus person", re.I)
NO_SPONSOR = re.compile(r"(without|not|no)\s+(requir\w+\s+)?(current or future\s+)?"
                        r"(visa\s+)?sponsorship", re.I)


def norm(name):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", name.lower())).strip()


def fame_tier(company):
    n = norm(company)
    if n in FAME_MAP:
        return FAME_MAP[n]
    # "Tesla Energy", "Google DeepMind", "Qualcomm Technologies" -> leading-name match
    for key, tier in FAME_MAP.items():
        if len(key) > 3 and (n.startswith(key + " ") or n == key):
            return tier
    return 0


# ---------------------------------------------------------------- IMAP


def dh(s):
    out = ""
    for part, enc in decode_header(s or ""):
        out += part.decode(enc or "utf8", "replace") if isinstance(part, bytes) else part
    return out


def fetch_emails(since):
    """Searches every configured mailbox in order; the first one holding list emails wins."""
    for addr, pw in PC.mailboxes():
        out = fetch_from(addr, pw, since)
        if out:
            return out
    return []


def fetch_from(addr, pw, since):
    M = imaplib.IMAP4_SSL(PC.imap_host())
    M.login(addr, pw)
    M.select('"%s"' % PC.cfg("mail.folder", "INBOX"), readonly=True)
    _, data = M.search(None, f'(FROM "{SENDER}" SINCE "{since}")')
    out = []
    for i in data[0].split():
        _, md = M.fetch(i, "(BODY.PEEK[])")
        msg = email.message_from_bytes(md[0][1])
        body = ""
        for p in msg.walk():
            if p.get_content_type() == "text/html":
                body = p.get_payload(decode=True).decode(p.get_content_charset() or "utf8",
                                                         "replace")
        # The same daily email can reach several mailboxes under different Message-IDs; key on
        # subject + send date so switching mailboxes never re-sends a digest.
        day = email.utils.parsedate_to_datetime(msg["Date"]).strftime("%Y-%m-%d")
        out.append({"id": f"{dh(msg['Subject']).strip()}|{day}", "subject": dh(msg["Subject"]),
                    "date": dh(msg["Date"]), "html": body})
    M.logout()
    return out


def parse_rows(body):
    """SWE List body is a sequence of `Company:` text followed by a linked role."""
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S)
    rows, company = [], None
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>|([^<>]+)', body, re.S):
        href, anchor, text = m.groups()
        if text is not None:
            t = htmllib.unescape(text).strip()
            if t.endswith(":") and 0 < len(t) < 80 and "\n" not in t:
                company = t[:-1].strip()
        elif href and "simplify.jobs/p/" in href and company:
            role = re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", "", anchor))).strip()
            rows.append({"company": company, "role": role, "url": href.split("?")[0]})
            company = None
    return rows


# ---------------------------------------------------------------- scoring

def assess(row):
    """Return (chance 0-3, notes list, blocked reason or None)."""
    notes = []
    comp = norm(row["company"])
    for key, why in COMPANY_INELIGIBLE.items():
        if comp.startswith(key):
            return 0, notes, why
    if itar_match(comp):
        if BLOCK_ITAR:
            return 0, notes, "defense/ITAR employer"
        notes.append("defense/ITAR employer: check eligibility")

    verdict, reason, flags = prescreen.screen(row)
    if verdict == "drop":
        return 0, notes, reason
    blob = row.get("blob") or ""
    if CLEARANCE.search(blob):
        if BLOCK_CLEARANCE:
            return 0, notes, "clearance / US-citizen requirement"
        notes.append("clearance / US-citizen requirement")

    chance = 3
    title = row["role"]
    if NON_TECH.search(title) and not re.search(r"software|data|machine learning", title, re.I):
        chance -= 2
        notes.append("non-SWE role")
    elif not TECH_ROLE.search(title):
        chance -= 1
    if re.search(r"\bph\.?d\b|master", title, re.I):
        chance -= 2
        notes.append("PhD/Master's in title")
    if flags:
        chance -= 1
        notes.append("outside allowed countries")
    if EXPORT.search(blob):
        chance -= 1
        notes.append("export licence may be needed")
    if NO_SPONSOR.search(blob):
        chance -= 1
        notes.append("says no sponsorship")
    if row.get("fetch_failed"):
        notes.append("details unverified")
    elif row.get("degrees") and prescreen.DEGREES_OK & set(row["degrees"]):
        notes.append("degree OK")
    if row.get("seasons"):
        terms = sorted({(s[1], s[0]) for s in row["seasons"] if s and len(s) >= 2})
        if terms:
            notes.append("/".join(f"{prescreen.SEASON_NAME.get(c, c)} {y}"
                                  for y, c in terms[:2]))
    return max(chance, 0), notes, None


TOP10 = PC.path("TOP10.json")
RECORD = True   # main() turns this off for plain --dry-run


def record_top10(day, companies):
    """Append this email's top companies to TOP10.json (next-batch.js holds them back when
    config queue.hold_top_list is true, e.g. if you prefer to apply to those yourself)."""
    if not RECORD:
        return
    try:
        doc = json.load(open(TOP10))
    except FileNotFoundError:
        doc = {"_comment": "Top-N companies from each job-list digest. next-batch.js holds them "
                           "back from appliers when config queue.hold_top_list is true.",
               "entries": []}
    have = {(e["company"], e["email_day"]) for e in doc["entries"]}
    for company, urls in companies:
        if (company, day) not in have:
            doc["entries"].append({"company": company, "email_day": day, "urls": urls,
                                   "recorded": dt.date.today().isoformat()})
    os.makedirs(os.path.dirname(TOP10), exist_ok=True)
    json.dump(doc, open(TOP10, "w"), indent=1, ensure_ascii=False)


def build_digest(mail, jds):
    by_company = {}
    for r in jds:
        chance, notes, blocked = assess(r)
        r["_chance"], r["_notes"], r["_blocked"] = chance, notes, blocked
        by_company.setdefault(r["company"], []).append(r)

    ranked = []
    for company, rs in by_company.items():
        best = max(rs, key=lambda r: r["_chance"])
        tier = fame_tier(company)
        if best["_blocked"] and best["_chance"] == 0:
            continue
        ranked.append((tier * 2 + best["_chance"] * 1.5, tier, company, best, rs))
    ranked.sort(key=lambda x: (-x[0], x[2].lower()))
    top = ranked[:TOP_N]

    n_eligible = sum(1 for r in jds if not r["_blocked"])
    d = re.search(r"\(([\d/]+)\)", mail["html"])
    day = d.group(1) if d else mail["date"][:16]
    plural = lambda n, w: f"{n} {w}" + ("" if n == 1 else "s")
    lines = [f"**SWE List {day}: {plural(len(jds), 'posting')} from "
             f"{plural(len(by_company), 'company').replace('companys', 'companies')}, "
             f"{n_eligible} pass the eligibility checks.**",
             f"Top {len(top)} (famous or best chance):" if top else ""]
    for i, (_, tier, company, best, rs) in enumerate(top, 1):
        tag = {3: "⭐ famous", 2: "known", 0: "", 1: ""}[tier]
        chance = {3: "good chance", 2: "decent chance", 1: "long shot", 0: "long shot"}[best["_chance"]]
        bits = ", ".join(x for x in [tag, chance] + best["_notes"] if x)
        # List every open, eligible posting at the company with its link, not just the best one.
        ok = [r for r in rs if not r["_blocked"]] or [best]
        posts = "\n".join(f"   • {r['role']}: <{r['url']}>" for r in ok)
        lines.append(f"{i}. **{company}** ({bits})\n{posts}")
    if not top:
        lines.append("Nothing on today's list clears the eligibility checks.")
    record_top10(day, [(company, [r["url"] for r in rs if not r["_blocked"]]) for _, _, company, _, rs in top])
    lines.append("_Scored by eligibility (degree, term, clearance, sponsorship) and name "
                 "recognition. Fit is a human call._")
    return "\n".join(lines)


# ---------------------------------------------------------------- main

def load_seen():
    try:
        return set(json.load(open(STATE)))
    except FileNotFoundError:
        return set()


def save_seen(seen):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(sorted(seen), open(STATE, "w"), indent=1)


def send(text):
    if not PC.notify(text):
        raise SystemExit("notify failed (check NOTIFY_CMD)")


def main():
    global RECORD
    dry = "--dry-run" in sys.argv
    RECORD = not dry or "--record-top10" in sys.argv
    if "-h" in sys.argv or "--help" in sys.argv:
        raise SystemExit(__doc__)
    since = (dt.date.today() - dt.timedelta(days=LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    if "--since" in sys.argv:
        since = sys.argv[sys.argv.index("--since") + 1]
    seen = load_seen()
    mails = fetch_emails(since)

    if "--seed" in sys.argv:
        save_seen(seen | {m["id"] for m in mails})
        print(f"seeded {len(mails)} emails")
        return

    # --dry-run with an explicit --since replays already-seen emails for testing.
    replay = dry and "--since" in sys.argv
    new = [m for m in mails if replay or m["id"] not in seen]
    if not new:
        print("NO_NEW_EMAIL")
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    for m in new:
        rows = parse_rows(m["html"])
        stamp = re.sub(r"[^0-9A-Za-z]", "", m["id"])[:24]
        raw, jds_path = (os.path.join(STATE_DIR, f"{stamp}-{x}.json") for x in ("raw", "jds"))
        json.dump(rows, open(raw, "w"), indent=1)
        if rows:
            subprocess.run([sys.executable, os.path.join(HERE, "fetch-jds.py"), raw, jds_path,
                            "--no-carryover"], check=True, capture_output=True)
            jds = json.load(open(jds_path))
        else:
            jds = []
        text = build_digest(m, jds)
        print(text + "\n")
        if not dry:
            send(text)
            seen.add(m["id"])
            save_seen(seen)


if __name__ == "__main__":
    main()
