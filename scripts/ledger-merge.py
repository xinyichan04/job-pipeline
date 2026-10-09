#!/usr/bin/env python3
"""Deterministic ledger merge for Stage 3 (reconcile).

    python3 ledger-merge.py <run-dir> [--queue queue.json] [--json out.json] [--full]

Why this exists
---------------
A reconcile agent once spent 157k tokens merging six ledger parts. Counting rows,
tallying outcomes and checking queue coverage are mechanical: a script does them for zero
agent tokens and, unlike an agent skimming 125KB of prose, cannot miscount. This script
produces the counts and the coverage table, and surfaces ONLY the exceptions that need
a human/agent judgement call.

Safety rules this script is built around (do not "simplify" these away)
----------------------------------------------------------------------
* Identity is the 8-hex unique key and NOTHING else. Company+role is NOT unique -- Disney
  posts two distinct "Systems Software Engineer Intern" reqs. Rows are matched, deduped and
  coverage-checked on the key only. Title collisions are reported separately as
  INFO, never merged.
* "submitted" is only believed when the row also carries confirmation evidence (a
  confirmation page quote or an email). A row claiming submitted without evidence is
  raised as an exception for the agent to verify, never silently counted as a success.
* Appliers write ledgers in at least four heading formats. The parser is format-agnostic
  and reports anything it could not parse instead of dropping it.
* This script never edits a ledger, a queue or any live pipeline file. Read-only.
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

HEX8 = re.compile(r'\b([0-9a-f]{8})\b')

# Canonical outcome vocabulary harvested from every ledger under runs/.
CANON = {
    'submitted': 'submitted',
    'challenge': 'challenge',
    'drop-at-apply': 'drop-at-apply',
    'dropped-at-apply': 'drop-at-apply',
    'parked': 'parked',
    'park': 'parked',
    'failed': 'failed',
    'duplicate': 'duplicate',
    'skipped': 'skipped',
    'skipped-held': 'skipped',
    'held': 'skipped',
    'timebox': 'timebox',
    'closed': 'closed',
    'awaiting-approval': 'awaiting-approval',
}
OUTCOME_RE = re.compile(
    r'outcome[:\s*]*\**\s*(' + '|'.join(sorted(CANON, key=len, reverse=True)) + r')\b',
    re.I)

# Evidence that a submission really landed. Deliberately narrow: only a confirmation page
# or an email counts, per the standing rule.
CONFIRM_RE = re.compile(
    r'confirmation|confirmed via|thank you for (applying|your (interest|application))'
    r'|successfully submitted|application (was )?(received|submitted)'
    r'|we.ll (be in touch|contact you)|application id|reference number'
    r'|job_application_id|redirected to [^\s]*success|/success\b',
    re.I)

# Appliers often state the result instead of labelling it:
#   "- autosubmit gate open. Submitted -- confirmation: "Success" page shown."
# This fallback is deliberately asymmetric: it may only ever conclude "submitted" when the
# block ALSO carries confirmation evidence (CONFIRM_RE). It can therefore never manufacture
# a success out of a bare claim -- which is the whole point of the confirmation rule.
SUBMITTED_STMT_RE = re.compile(r'^\s*[-*]?\s*(?:.*?\.\s*)?Submitted\b', re.M)

# Heading formats seen in the wild, most specific first.
HEAD_PATTERNS = [
    # ## key cd6f32c7 — AMI — Computer Vision Scientist Intern (...) — Ashby
    re.compile(r'^#+\s*key\s+([0-9a-f]{8})\s*[—-]\s*(.+?)\s*[—-]\s*(.+?)\s*(?:[—-]\s*(.+?))?\s*$'),
    # ## orig_index 135 — Tesla — Android Engineer Intern - Mobile Software — key 0b09ad76
    re.compile(r'^#+\s*orig_index\s+\d+\s*[—-]\s*(?P<co>.+?)\s*[—-]\s*(?P<role>.+?)\s*[—-]\s*key\s+(?P<key>[0-9a-f]{8})\s*$'),
    # ## Achievers — Software Engineer Co-op - Winter 2027 (key 0852a12d)
    re.compile(r'^#+\s*(?P<co>.+?)\s*[—-]\s*(?P<role>.+?)\s*\(key\s+(?P<key>[0-9a-f]{8})\)\s*$'),
]

# Some rows are identified only by their position in the queue, with no key in the heading:
#   ## orig_index 69 — Honeywell — Software Engineer Intern - Computer Science — Workday
# orig_index is unique only WITHIN one queue, so these are tracked under an 'oi:<n>' identity
# and reported, never silently folded in with key-identified rows.
ORIGIDX_RE = re.compile(
    r'^#+\s*orig_index\s+(?P<oi>\d+)\s*[—-]\s*(?P<co>.+?)\s*[—-]\s*(?P<role>.+?)'
    r'(?:\s*[—-]\s*(?P<ats>[^—-]+?))?\s*$')


def parse_part(path):
    """-> (list of row dicts, list of unparsed heading strings)"""
    txt = open(path, encoding='utf-8', errors='replace').read()
    # Split into blocks on '## ' headings, keeping the heading with its body.
    chunks = re.split(r'^(#{2,}\s+.*)$', txt, flags=re.M)
    rows, unparsed = [], []
    # chunks[0] is any preamble before the first heading; then heading, body, heading, body...
    for i in range(1, len(chunks) - 1, 2):
        head, body = chunks[i].strip(), chunks[i + 1]
        block = head + '\n' + body
        key = co = role = ats = None
        for pat in HEAD_PATTERNS:
            m = pat.match(head)
            if not m:
                continue
            gd = m.groupdict()
            if gd:
                key, co, role = gd.get('key'), gd.get('co'), gd.get('role')
            else:
                key, co, role, ats = (m.group(1), m.group(2), m.group(3),
                                      m.group(4) if m.lastindex and m.lastindex >= 4 else None)
            break
        orig_index = None
        if not key:
            oim = ORIGIDX_RE.match(head)
            if oim and not HEX8.search(head):
                orig_index = int(oim.group('oi'))
                key = f'oi:{orig_index}'
                co, role, ats = oim.group('co'), oim.group('role'), oim.group('ats')
        if not key:
            # Fall back to any 8-hex in the heading, then anywhere in the block.
            hm = HEX8.search(head) or HEX8.search(block)
            if hm:
                key = hm.group(1)
                # Strip leading '#' and the key itself, then take the first two ' — ' fields.
                bits = [b.strip() for b in re.sub(r'^#+\s*', '', head).split('—')]
                bits = [b for b in bits if b and key not in b]
                co = bits[0] if bits else None
                role = bits[1] if len(bits) > 1 else None
            else:
                if head.lstrip('#').strip():
                    unparsed.append((os.path.basename(path), head))
                continue
        om = OUTCOME_RE.search(block)
        confirmed = bool(CONFIRM_RE.search(block))
        if om:
            outcome = CANON[om.group(1).lower()]
        elif confirmed and SUBMITTED_STMT_RE.search(block):
            outcome = 'submitted'          # stated + evidenced; see SUBMITTED_STMT_RE
        else:
            outcome = None
        rows.append({
            'key': key,
            'company': (co or '').strip(),
            'role': (role or '').strip(),
            'ats': (ats or '').strip() or None,
            'orig_index': orig_index,
            'outcome': outcome,
            'confirmed': confirmed,
            'part': os.path.basename(path),
            'chars': len(block),
        })
    return rows, unparsed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rundir', help='run directory (ledger parts found recursively)')
    ap.add_argument('--queue', help='the queue/joblist JSON this run was slicing, for coverage')
    ap.add_argument('--json', help='write the full merged structure here')
    ap.add_argument('--full', action='store_true', help='also print every merged row')
    ap.add_argument('--include-merged', action='store_true',
                    help="also parse the run's own ledger.md (double-counts; for audit only)")
    args = ap.parse_args()

    # Prefer the per-applier PARTS. The run's own merged ledger.md is a summary OF those
    # parts, so including it double-counts every key it covers.
    parts = sorted(set(
        glob.glob(os.path.join(args.rundir, 'ledger-part*.md')) +
        glob.glob(os.path.join(args.rundir, '*', 'ledger-part*.md'))))
    if not parts and args.include_merged is not False:
        parts = sorted(glob.glob(os.path.join(args.rundir, 'ledger*.md')))
    if args.include_merged:
        parts = sorted(set(parts) | set(glob.glob(os.path.join(args.rundir, 'ledger.md'))))
    if not parts:
        raise SystemExit(f'no ledger parts under {args.rundir}')

    all_rows, unparsed = [], []
    print(f'=== PARTS ({len(parts)}) ===')
    for p in parts:
        rows, un = parse_part(p)
        all_rows += rows
        unparsed += un
        kb = os.path.getsize(p) / 1024
        noout = sum(1 for r in rows if not r['outcome'])
        print(f'  {os.path.basename(p):42s} {kb:7.1f}KB  {len(rows):4d} rows'
              f'{f"  ({noout} with no parsed outcome)" if noout else ""}')

    by_key = defaultdict(list)
    for r in all_rows:
        by_key[r['key']].append(r)

    # Load the queue up front: it is what lets an 'oi:<n>' ledger row be resolved to its real
    # unique key, which must happen BEFORE the tally and the exception checks so those rows
    # are neither double-counted nor wrongly flagged.
    qkeys, resolved_oi = {}, 0
    if args.queue:
        by_oi = {}
        for i, q in enumerate(json.load(open(args.queue))):
            k = (q.get('key') or '')[:8]
            if k:
                qkeys[k] = q
                by_oi[q.get('orig_index', i)] = k
        def _norm(x):
            return re.sub(r'[^a-z0-9]+', '', (x or '').lower())[:18]

        for ident in [k for k in list(by_key) if k.startswith('oi:')]:
            real = by_oi.get(int(ident[3:]))
            if not real:
                continue
            # VERIFY before adopting. orig_index is unique only within the queue that applier
            # actually worked, and callers pass whatever queue is current. This once silently
            # mapped one applier's "orig_index 86 - <company A>" onto row 86 of a later queue,
            # which was a different company - a wrong key attribution that would retire the wrong
            # posting if it ever reached the dedup. An index match with a company mismatch is
            # evidence the queue is the WRONG one, so refuse it rather than guess.
            blocks = by_key[ident]
            led_co = _norm(next((b.get('company') for b in blocks if b.get('company')), ''))
            q_co = _norm((qkeys.get(real) or {}).get('company'))
            if led_co and q_co and led_co != q_co:
                for b in blocks:
                    b['oi_mismatch'] = f'orig_index {ident[3:]} -> {q_co} in this queue, ledger says {led_co}'
                continue
            by_key.setdefault(real, []).extend(by_key.pop(ident))
            resolved_oi += 1

    print(f'\n=== TOTALS ===')
    print(f'  ledger row blocks parsed : {len(all_rows)}')
    print(f'  distinct unique keys     : {len(by_key)}')

    # Outcome tally, one vote per KEY (not per block) so a re-tried row is not double counted.
    def resolve(rs):
        outs = [r['outcome'] for r in rs if r['outcome']]
        if not outs:
            return None
        # A later/positive outcome wins: submitted beats everything (it is terminal).
        return 'submitted' if 'submitted' in outs else outs[-1]

    tally = Counter(resolve(rs) or '(unparsed outcome)' for rs in by_key.values())
    print('\n=== OUTCOMES (one vote per unique key) ===')
    for k, v in tally.most_common():
        print(f'  {k:22s} {v:4d}')

    exceptions = []

    # -- exception: claimed submitted with no confirmation evidence in the block
    for key, rs in by_key.items():
        if resolve(rs) == 'submitted' and not any(r['confirmed'] for r in rs):
            r = rs[0]
            exceptions.append(('SUBMITTED-NO-CONFIRMATION',
                               f'{key}  {r["company"]} — {r["role"]}  [{r["part"]}]'))

    # -- exception: the same unique key worked in more than one part (wasted duplicate effort)
    for key, rs in by_key.items():
        if len({r['part'] for r in rs}) > 1:
            exceptions.append(('KEY-IN-MULTIPLE-PARTS',
                               f'{key}  {rs[0]["company"]} — {rs[0]["role"]}  parts: '
                               + ', '.join(sorted({r["part"] for r in rs}))
                               + '  outcomes: ' + ', '.join(str(r['outcome']) for r in rs)))

    # -- exception: a row identified only by orig_index that no queue could resolve to a key.
    # orig_index is unique only within one queue, so these cannot be trusted for dedup.
    for key, rs in by_key.items():
        if key.startswith('oi:'):
            exceptions.append(('ROW-WITHOUT-UNIQUE-KEY',
                               f'{key}  {rs[0]["company"]} — {rs[0]["role"]}  [{rs[0]["part"]}]'
                               f'  (pass --queue to resolve it)'))

    # -- exception: no outcome could be parsed at all
    for key, rs in by_key.items():
        if resolve(rs) is None:
            exceptions.append(('NO-OUTCOME-PARSED',
                               f'{key}  {rs[0]["company"]} — {rs[0]["role"]}  [{rs[0]["part"]}]'))

    # Headings carrying no key are usually lane/section banners, not rows. They are listed
    # separately rather than dropped: if one WAS a row, the queue coverage check below still
    # catches it as QUEUE-ROW-NOT-WORKED, so nothing can go missing silently.
    info_headings = [f'{head[:100]}  [{part}]' for part, head in unparsed]

    # -- coverage against the queue, on the unique key ONLY
    if args.queue:
        if resolved_oi:
            print(f'\n  NOTE: {resolved_oi} ledger rows identified by orig_index were resolved '
                  f'to their unique key via the queue.')
        missing = [k for k in qkeys if k not in by_key]
        extra = [k for k in by_key if k not in qkeys]
        print(f'\n=== COVERAGE vs {os.path.basename(args.queue)} ===')
        print(f'  queue rows with a key : {len(qkeys)}')
        print(f'  covered by a ledger   : {len(qkeys) - len(missing)}')
        print(f'  NOT accounted for     : {len(missing)}')
        for k in sorted(missing):
            q = qkeys[k]
            exceptions.append(('QUEUE-ROW-NOT-WORKED',
                               f'{k}  {q.get("company","?")} — {q.get("role","?")}'))
        if extra:
            print(f'  ledger keys not in this queue: {len(extra)} (other lanes/carryover)')

        # INFO only: title collisions. NEVER treated as the same row.
        seen = defaultdict(list)
        for k, q in qkeys.items():
            seen[(q.get('company', '').strip().lower(),
                  (q.get('role') or '').strip().lower())].append(k)
        colliding = {p: ks for p, ks in seen.items() if len(ks) > 1}
        if colliding:
            print(f'\n  INFO: {len(colliding)} company+role titles cover '
                  f'{sum(len(v) for v in colliding.values())} DISTINCT keys.')
            print('  These are separate reqs and must each be applied to separately.')
            for (co, role), ks in sorted(colliding.items())[:10]:
                print(f'    {co} — {role}: {" ".join(sorted(ks))}')

    print(f'\n=== EXCEPTIONS FOR THE AGENT ({len(exceptions)}) ===')
    if not exceptions:
        print('  none — the merge is fully mechanical, no judgement needed.')
    else:
        for kind, msg in sorted(exceptions):
            print(f'  [{kind}] {msg}')

    if info_headings:
        print(f'\n=== INFO: headings with no key ({len(info_headings)}, usually section banners) ===')
        for h in info_headings:
            print(f'  {h}')

    if args.full:
        print('\n=== ALL ROWS ===')
        for key, rs in sorted(by_key.items(), key=lambda kv: kv[1][0]['company'].lower()):
            r = rs[0]
            print(f'  {key}  {resolve(rs) or "?":18s} {r["company"]} — {r["role"]}')

    if args.json:
        out = {
            'parts': [os.path.basename(p) for p in parts],
            'totals': {'blocks': len(all_rows), 'keys': len(by_key)},
            'outcomes': dict(tally),
            'rows': {k: {'company': rs[0]['company'], 'role': rs[0]['role'],
                         'ats': rs[0]['ats'], 'outcome': resolve(rs),
                         'confirmed': any(r['confirmed'] for r in rs),
                         'parts': sorted({r['part'] for r in rs})}
                     for k, rs in by_key.items()},
            'exceptions': [{'kind': k, 'detail': m} for k, m in exceptions],
        }
        json.dump(out, open(args.json, 'w'), indent=1)
        print(f'\nwrote {args.json}')

    return 0


if __name__ == '__main__':
    sys.exit(main())
