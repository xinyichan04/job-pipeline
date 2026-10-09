#!/usr/bin/env python3
"""Pre-slice gate: do every deterministic check BEFORE spawning appliers.

    python3 preslice.py <queue.json> --out clean.json [--review r.json] [--dup d.json]
                        [--liveness live.json] [--dupcheck] [--slices N] [--quiet]

Why this exists
---------------
Measured on one setup: an applier costs ~86k tokens the moment it is spawned, before it
opens a single page, and ~613 tokens per tool call thereafter. One applier spent 82,971 tokens
to run already-applied.py six times and open zero pages -- work this script does for zero
agent tokens. Another burned an overnight window on a slice where 6 of 20 rows had already been
applied to.

So: filter here, in the orchestrator, and hand appliers only rows that are unworked, live and
not already applied to. Then check whether the surviving slice is even worth an agent at all.

Safety rules this script is built around (do not "simplify" these away)
----------------------------------------------------------------------
* Dedup is on the 8-hex unique key ONLY. Company+role is NOT unique -- Disney posts two
  distinct "Systems Software Engineer Intern" reqs. Title-only matches go to --review for a
  human/agent decision; they are NEVER auto-dropped. Both rules are enforced by reusing
  worked-keys.py's own harvest()/split(), not by a second copy of the logic here.
* The duplicate check shells out to already-applied.py, the exact script the appliers run,
  so the batch pre-pass and the per-row check can never disagree. Exit 3 = duplicate,
  exit 0/4 = apply. Any other exit (crash, timeout) is treated as UNKNOWN and the row is
  KEPT -- a failed check is not evidence of a prior application.
* Liveness 'unknown' keeps the row. An unreachable probe is not evidence a posting is dead.
* This script only ever filters rows out of a slice. It never edits a queue, a ledger, a
  profile or any live pipeline file, and it never decides an application's content.
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
from collections import Counter

S = os.path.dirname(os.path.abspath(__file__))

# Measured once by least-squares over four applier runs; re-measure for your own model/setup.
# The fit is linear -- tokens = FIXED + PER_CALL * calls -- with <1% error on the two large
# appliers. Cost does NOT grow with context x calls; prompt caching makes the marginal call
# cheap. These constants drive the slice-economics advice only, nothing functional.
FIXED_SPAWN_TOKENS = 86_000
PER_CALL_TOKENS = 613
CALLS_PER_ROW = 31          # one measured applier: 680 calls / 22 rows


def load_worked_keys():
    """Import worked-keys.py (hyphenated, so not a normal import) for its ONE dedup impl."""
    spec = importlib.util.spec_from_file_location('worked_keys', os.path.join(S, 'worked-keys.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def dup_check(row, timeout=120):
    """Run the appliers' own already-applied.py. -> ('duplicate'|'apply'|'unknown', detail)"""
    try:
        p = subprocess.run(
            [sys.executable, os.path.join(S, 'already-applied.py'),
             row.get('company', ''), row.get('role', '') or '']
            + (['--key', row['key'][:8]] if row.get('key') else []),
            capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        return 'unknown', f'check failed: {e}'
    last = [l for l in p.stdout.splitlines() if l.startswith('RESULT:')]
    detail = last[-1][8:].strip() if last else p.stdout.strip()[:120]
    if p.returncode == 3:
        return 'duplicate', detail
    if p.returncode in (0, 4):
        return 'apply', detail
    return 'unknown', f'exit {p.returncode}: {detail or p.stderr.strip()[:120]}'


def economics(n_rows, n_slices):
    per = n_rows / n_slices if n_slices else n_rows
    marginal = per * CALLS_PER_ROW * PER_CALL_TOKENS
    total = n_slices * (FIXED_SPAWN_TOKENS + marginal)
    overhead = n_slices * FIXED_SPAWN_TOKENS
    return per, total, overhead, (overhead / total * 100 if total else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('queue')
    ap.add_argument('--out', required=True, help='rows an applier should actually receive')
    ap.add_argument('--review', help='title-only matches needing a decision (NEVER auto-dropped)')
    ap.add_argument('--dup', help='rows already applied to, per already-applied.py')
    ap.add_argument('--liveness', help='liveness-probe.py sidecar JSON, to drop closed/expired')
    ap.add_argument('--dupcheck', action='store_true',
                    help='run already-applied.py per surviving row (slow, but zero agent tokens)')
    ap.add_argument('--slices', type=int, default=2, help='appliers you plan to spawn')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    rows = json.load(open(args.queue))
    n0 = len(rows)
    print(f'=== PRESLICE {os.path.basename(args.queue)}: {n0} rows ===')

    # -- Stage A: already worked, per the ledgers. Unique key only.
    wk = load_worked_keys()
    hexes, pairs = wk.harvest()
    worked, review, clean = wk.split(rows, hexes, pairs)
    print(f'\n[A] ledger dedup (unique key only; {len(hexes)} keys known)')
    print(f'    already worked : {len(worked):4d}  (dropped)')
    print(f'    title-only hit : {len(review):4d}  (-> review, NOT dropped: company+role is not unique)')
    print(f'    clean          : {len(clean):4d}')

    # -- Stage B: liveness. 'unknown' is kept on purpose.
    if args.liveness:
        probes = {p['key']: p for p in json.load(open(args.liveness)) if p.get('key')}
        kept, dead = [], []
        vt = Counter()
        for r in clean:
            v = (probes.get(r.get('key'), {}) or {}).get('verdict', 'unprobed')
            vt[v] += 1
            if v in ('closed', 'expired'):
                r = dict(r, dropped_reason=f'liveness: {v}')
                dead.append(r)
            else:
                if probes.get(r.get('key'), {}).get('ats_url'):
                    r = dict(r, ats_url=probes[r['key']]['ats_url'])
                kept.append(r)
        print(f'\n[B] liveness  ' + '  '.join(f'{k}={v}' for k, v in sorted(vt.items())))
        print(f'    dropped closed/expired : {len(dead)}   kept (incl. unknown/unprobed): {len(kept)}')
        clean = kept

    # -- Stage C: the duplicate check the appliers would each have run themselves.
    dups = []
    if args.dupcheck:
        print(f'\n[C] already-applied.py on {len(clean)} rows '
              f'(work an applier agent would otherwise spend tokens on)')

        # already-applied.py matches confirmation emails and ledger rows on company+role,
        # which is NOT a unique identifier. Where this queue holds more than one distinct key
        # under the same company+role (Audax Group / Data Engineer Co-op has two; Disney posts
        # two "Systems Software Engineer Intern" reqs), an exit 3 cannot say WHICH req was
        # applied to. Dropping both would silently lose a real job, so an ambiguous duplicate
        # is routed to --review for a decision instead of being treated as settled.
        ambiguous = Counter((r.get('company', '').strip().lower(),
                             (r.get('role') or '').strip().lower()) for r in clean)

        survivors = []
        tally = Counter()
        for i, r in enumerate(clean, 1):
            verdict, detail = dup_check(r)
            pair = (r.get('company', '').strip().lower(), (r.get('role') or '').strip().lower())
            if verdict == 'duplicate' and ambiguous[pair] > 1:
                verdict = 'ambiguous'
                detail = (f'{ambiguous[pair]} distinct keys share this company+role; '
                          f'duplicate evidence cannot say which. {detail}')
            tally[verdict] += 1
            if verdict == 'duplicate':
                dups.append(dict(r, duplicate_evidence=detail))
            elif verdict == 'ambiguous':
                review.append(dict(r, review_reason=detail))
            else:
                survivors.append(dict(r, dupcheck=verdict))
            if not args.quiet:
                mark = {'duplicate': 'DUP ', 'apply': '  ok',
                        'unknown': 'WARN', 'ambiguous': 'AMBI'}[verdict]
                print(f'    {mark} [{i:3d}/{len(clean)}] {r.get("company","?")[:28]:28s} '
                      f'{(r.get("role") or "?")[:40]:40s} {detail[:60]}')
        print(f'    -> ' + '  '.join(f'{k}={v}' for k, v in sorted(tally.items()))
              + '   (unknown is KEPT; ambiguous -> review, never dropped)')
        clean = survivors

    json.dump(clean, open(args.out, 'w'), indent=1)
    print(f'\nwrote {args.out} ({len(clean)} rows)')
    for path, data, label in ((args.review, review, 'review'), (args.dup, dups, 'duplicate')):
        if path:
            json.dump(data, open(path, 'w'), indent=1)
            print(f'wrote {path} ({len(data)} {label} rows)')

    # -- Stage D: is this slice even worth an agent? (proposal 6)
    print(f'\n=== SLICE ECONOMICS ({len(clean)} rows over {args.slices} applier(s)) ===')
    print(f'    model: {FIXED_SPAWN_TOKENS:,} fixed per spawn + {PER_CALL_TOKENS}/call '
          f'x ~{CALLS_PER_ROW} calls/row')
    if not clean:
        print('    0 rows survive -- DO NOT SPAWN AN APPLIER. Everything was already '
              'worked, dead or a duplicate.')
        return 0
    per, total, overhead, pct = economics(len(clean), args.slices)
    print(f'    ~{per:.1f} rows/applier   est. total ~{total/1000:.0f}k tokens, '
          f'of which ~{overhead/1000:.0f}k ({pct:.0f}%) is pure spawn overhead')
    for n in range(1, max(args.slices, 4) + 1):
        _, t, _, p = economics(len(clean), n)
        flag = '  <-- planned' if n == args.slices else ''
        print(f'      {n} applier(s): ~{t/1000:6.0f}k tokens, {p:4.0f}% overhead{flag}')
    if per < 5:
        print(f'\n    ADVICE: {per:.1f} rows/applier is below the break-even band. '
              f'Spawn fewer appliers, or handle these rows in the orchestrator.')
    elif pct > 30:
        print(f'\n    ADVICE: {pct:.0f}% of spend is spawn overhead. Use fewer, fatter slices.')
    else:
        print(f'\n    Slice size is economic.')
    print('    NOTE: parallel appliers still buy wall-clock time. This is a token '
          'estimate, not an instruction to serialise everything.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
