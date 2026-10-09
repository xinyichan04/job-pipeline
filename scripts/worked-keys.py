#!/usr/bin/env python3
"""Which rows of a queue have already been worked?

    python3 worked-keys.py <queue.json> [--clean OUT.json] [--review OUT.json]

Why this exists: a hand-rolled `grep -oE 'key [0-9a-f]{8}'` over the ledgers
found 413 keys and declared 262 August rows unworked. It was wrong — appliers write ledgers in
at least three formats ('## key <hex> — Co — Role — ATS' headings, '| n | Co | Role | key |'
tables, and free prose), and the grep only understood the first. A format-agnostic scan finds
1051 keys. One applier then burned a whole overnight window on a slice where 6 of 20 rows had
already been applied to.

The safety rule that matters: dedup ONLY on the unique key. Company+role is NOT unique — Disney
posts two distinct "Systems Software Engineer Intern" reqs, Ambarella three "Software Engineer
Intern", and 28 rows of one backfill queue shared a title with a genuinely different posting.
Matching on company+role would silently discard real jobs, so those land in --review instead.
"""
import re, json, glob, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

BASE = PC.home()   # ledgers live under $PIPELINE_HOME/runs/<run>/ledger*.md


# A key counts as WORKED only if something actually happened to it. Two agents independently hit
# this: one applier's ledger records six rows it deliberately did NOT touch ("ATS
# opened? No | Submitted? No"), and an applier logged 13 rows it parked without opening. A bare hex
# scan counted all of those as done and would have silently retired live postings - AutoZone,
# Fidelity, Interstates x2, Mercury and both BNY rows. "Logged in a ledger" is not "worked".
# Only phrases that ARE a submission confirmation. Deliberately excludes a bare mention of a
# "confirmation email", which appears in duplicate-CHECK notes for rows nobody applied to
# (an applier's Interstates rows said company confirmations exist but name no matching role).
CONFIRMED = re.compile(r'(application submitted|thank you for applying|'
                       r'your application (for [^\n]{0,80})?has been (sent|submitted|received))',
                       re.I)
# An explicit "nothing happened" marker. This is the only thing that can override a confirmation
# phrase, because confirmation phrases also appear inside QUOTED email subjects used as
# duplicate-check evidence ('"Thank you for applying to Interstates"' on a row never opened).
NEGATIVE = re.compile(r'(submitted\?\s*\**\s*no|ats opened\?\s*\**\s*no|did not submit|'
                      r'never (touched|started|opened)|not started|no submission|'
                      r'would have proceeded)', re.I)
TERMINAL = re.compile(r'(submitted|duplicate|drop-at-apply|dropped|failed|withdrawn)', re.I)
NONTERMINAL = re.compile(r'\b(not started|never (touched|started|opened)|parked|challenge|'
                         r'skipped-held|held|timebox|ats opened\? *\**no|submitted\? *\**no)\b',
                         re.I)


def _blocks(txt):
    """Split a ledger into per-row chunks, whichever format it uses."""
    # Three real formats, and they need three different splits:
    #  - '## key <hex> - Co - Role - ATS' prose sections   -> split on the heading
    #  - '| n | Co | Role | key | ATS | outcome |' tables   -> ONE ROW PER LINE. Splitting a table
    #    on blank lines makes it one block, so a single 'submitted' anywhere marks every key in
    #    the table worked - that wrongly retired all 6 of one applier's untouched rows.
    #  - merged day ledgers (no headings, no table)         -> paragraphs, because the key and its
    #    'outcome:' line are separate LINES of the same paragraph (Zoomifier, 09-20).
    table = [ln for ln in txt.splitlines() if ln.lstrip().startswith('|')]
    rest = '\n'.join(ln for ln in txt.splitlines() if not ln.lstrip().startswith('|'))
    if re.search(r'^## key [0-9a-f]{8}', rest, re.M):
        parts = re.split(r'(?=^## key [0-9a-f]{8})', rest, flags=re.M)
    else:
        parts = re.split(r'\n\s*\n', rest)
    return [p for p in parts + table if p.strip()]


def harvest(base=BASE):
    """-> (set of 8-hex keys WORKED, set of (company, role)) seen in every ledger, any format."""
    hexes, pairs = set(), set()
    for f in glob.glob(f'{base}/runs/*/ledger*.md') + glob.glob(f'{base}/runs/*/*/*.md'):
        try:
            txt = open(f, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        for blk in _blocks(txt):
            keys = set(re.findall(r'\b[0-9a-f]{8}\b', blk))
            if not keys:
                continue
            # Prefer the row's DECLARED outcome. A long prose entry for a submitted row often
            # also mentions "parked" or "challenge" in passing (Marmon, Zoomifier on 09-20), and a
            # loose keyword veto silently un-worked two real submissions. Only fall back to the
            # keyword scan when the row declares no outcome at all.
            # A real confirmation beats everything: some rows record the submission in prose
            # ("Submitted -- confirmation page: Application submitted!") with no Outcome: line,
            # and a stray word like "parked" elsewhere in the block was vetoing them (Zoomifier).
            if CONFIRMED.search(blk) and not NEGATIVE.search(blk):
                hexes |= keys
                continue
            decl = re.findall(r'outcome:?\s*\**\s*([a-z][a-z -]*)', blk, re.I)
            if decl:
                if any(TERMINAL.fullmatch(d.strip().split()[0]) for d in decl if d.strip()):
                    hexes |= keys
            elif TERMINAL.search(blk) and not NONTERMINAL.search(blk):
                hexes |= keys
        for m in re.finditer(r'^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|', txt, re.M):
            pairs.add((m.group(1).strip().lower(), m.group(2).strip().lower()))
        for m in re.finditer(r'^## key [0-9a-f]{8}\s+—\s+([^—]+?)\s+—\s+([^—]+?)\s+—', txt, re.M):
            pairs.add((m.group(1).strip().lower(), m.group(2).strip().lower()))
    return hexes, pairs


def split(rows, hexes, pairs):
    worked, review, clean = [], [], []
    for r in rows:
        if (r.get('key') or '')[:8] in hexes:
            worked.append(r)
        elif (r.get('company', '').strip().lower(),
              (r.get('role') or '').strip().lower()) in pairs:
            review.append(r)
        else:
            clean.append(r)
    return worked, review, clean


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    rows = json.load(open(args[0]))
    hexes, pairs = harvest()
    worked, review, clean = split(rows, hexes, pairs)
    print(f'ledger keys known: {len(hexes)}   company/role pairs: {len(pairs)}')
    print(f'{args[0]}: {len(rows)} rows -> {len(clean)} clean, '
          f'{len(worked)} already worked (unique key), {len(review)} need review (title-only match)')
    for flag, out in (('--clean', clean), ('--review', review)):
        if flag in args:
            p = args[args.index(flag) + 1]
            json.dump(out, open(p, 'w'), indent=1)
            print(f'wrote {p} ({len(out)})')


if __name__ == '__main__':
    main()
