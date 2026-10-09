#!/usr/bin/env python3
"""Per-ATS known-issue brief, mined from the issue log ($PIPELINE_HOME/issues.jsonl, written by issues.js).

    python3 ats-brief.py rank [--top N]      # which recurring problems cost the most time
    python3 ats-brief.py <ATS> [--max N]     # compact brief for ONE ATS, for an applier to load
    python3 ats-brief.py list                # ATSes present in the log

Why this exists
---------------
Ledgers show appliers re-deriving the SAME widget behaviour on different rows: the
SuccessFactors custom combobox (34 min, an applier), Workday virtualised listboxes, Simplify
modal click timeouts (22 min, an applier). Each rediscovery is a long exploration loop, and
exploration loops are what breach the 15-minute ceiling.

issues.jsonl already records every one of those with an `ats`, a `kind`, a problem signature
`sig`, the `minutes` burned and the `outcome`. So the recipe cache does not need to be built
by hand -- it can be read straight out of the log. An applier about to work a SuccessFactors
row runs `ats-brief.py SuccessFactors` (a few hundred tokens) instead of rediscovering.

What this is NOT
----------------
This prints OBSERVED MECHANICS ONLY -- how a widget behaved and what worked on it. It never
carries answer content, biography, or eligibility facts. Those come from the profile and the
JD every time, never from a cache, so a stale brief can waste a little time but can never
produce a wrong or dishonest answer on an application. It is advisory: if the brief and the
live page disagree, the live page wins.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

LOG = os.environ.get('ISSUES_FILE') or PC.path('issues.jsonl')


def load(path=LOG):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def group(rows):
    """-> {(ats, kind, sig): {...aggregate...}}"""
    g = defaultdict(lambda: {'n': 0, 'minutes': 0.0, 'details': [], 'outcomes': defaultdict(int),
                             'companies': set(), 'steps': set(), 'resolved': []})
    for r in rows:
        ats = (r.get('ats') or 'unknown').strip()
        kind = (r.get('kind') or 'unknown').strip()
        sig = (r.get('sig') or '')[:8]
        e = g[(ats, kind, sig)]
        e['n'] += 1
        try:
            e['minutes'] += float(r.get('minutes') or 0)
        except (TypeError, ValueError):
            pass
        d = (r.get('detail') or '').strip()
        if d and d not in e['details']:
            e['details'].append(d)
        e['outcomes'][(r.get('outcome') or '?').strip()] += 1
        if r.get('company'):
            e['companies'].add(r['company'].strip())
        if r.get('step'):
            e['steps'].add(str(r['step']).strip())
        note = (r.get('note') or '').strip()
        if note and note not in e['resolved']:
            e['resolved'].append(note)
    return g


# A detail line that describes a fix rather than a symptom is the valuable part of a brief.
FIX_RE = re.compile(
    r'\b(worked|works|fix(ed)?|use[ds]?\b|instead|resolv|workaround|must |need(s|ed)? to '
    r'|solution|only .* works|after |via )', re.I)


def cmd_rank(g, top):
    rank = sorted(g.items(), key=lambda kv: (-kv[1]['minutes'], -kv[1]['n']))
    print(f'{"ATS":<20}{"kind":<14}{"sig":<10}{"hits":>5}{"min":>8}   outcomes')
    print('-' * 92)
    for (ats, kind, sig), e in rank[:top]:
        outs = ','.join(f'{k}={v}' for k, v in sorted(e['outcomes'].items(), key=lambda x: -x[1])[:3])
        print(f'{ats[:19]:<20}{kind[:13]:<14}{sig:<10}{e["n"]:>5}{e["minutes"]:>8.0f}   {outs}')
    tot = sum(e['minutes'] for e in g.values())
    shown = sum(e['minutes'] for _, e in rank[:top])
    print('-' * 92)
    print(f'{len(g)} distinct (ats,kind,sig) problems; {tot:.0f} min logged total, '
          f'{shown:.0f} min ({100*shown/tot if tot else 0:.0f}%) in the top {min(top,len(rank))}.')


def cmd_brief(g, ats, maxn):
    # The log's `ats` field is free text, so the same ATS appears as "Workday",
    # "Workday (workday.js)", "Greenhouse (company-embedded iframe)", "Simplify/iCIMS" ...
    # Match on containment either way so one query picks up every variant.
    q = ats.lower().strip()
    sel = {k: v for k, v in g.items()
           if k[0].lower() == q
           or q in k[0].lower()
           or k[0].lower().split(' (')[0].split('/')[0].strip() == q}
    if not sel:
        avail = sorted({k[0] for k in g})
        print(f'no logged issues for ATS {ats!r}.')
        print(f'known: {", ".join(avail)}')
        return 1
    rank = sorted(sel.items(), key=lambda kv: (-kv[1]['minutes'], -kv[1]['n']))
    ats_name = rank[0][0][0]
    tot_min = sum(e['minutes'] for _, e in rank)
    tot_hits = sum(e['n'] for _, e in rank)
    print(f'# {ats_name} — known issues ({tot_hits} logged hits, {tot_min:.0f} min burned)')
    print('# Observed mechanics only. The live page always wins over this brief.')
    print('# Answer content NEVER comes from here — use the profile and the JD.')
    for (_, kind, sig), e in rank[:maxn]:
        outs = ', '.join(f'{k} x{v}' for k, v in sorted(e['outcomes'].items(), key=lambda x: -x[1]))
        print(f'\n## {kind} [{sig}] — {e["n"]} hits, {e["minutes"]:.0f} min ({outs})')
        if e['steps']:
            print(f'   step: {", ".join(sorted(e["steps"])[:4])}')
        fixes = [d for d in e['details'] if FIX_RE.search(d)]
        others = [d for d in e['details'] if d not in fixes]
        for d in fixes[:3]:
            print(f'   WHAT WORKED: {d[:400]}')
        for d in others[:2]:
            print(f'   symptom    : {d[:300]}')
        for nline in e['resolved'][:2]:
            print(f'   note       : {nline[:300]}')
        if e['companies']:
            cs = sorted(e['companies'])
            print(f'   seen at    : {", ".join(cs[:6])}{" ..." if len(cs) > 6 else ""}')
    if len(rank) > maxn:
        print(f'\n({len(rank) - maxn} rarer problems omitted; --max to show more)')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target', help='"rank", "list", or an ATS name')
    ap.add_argument('--top', type=int, default=25)
    ap.add_argument('--max', type=int, default=8)
    ap.add_argument('--log', default=LOG)
    args = ap.parse_args()

    if not os.path.exists(args.log):
        raise SystemExit(f'no issue log at {args.log}')
    g = group(load(args.log))

    if args.target == 'rank':
        cmd_rank(g, args.top)
        return 0
    if args.target == 'list':
        per = defaultdict(lambda: [0, 0.0])
        for (ats, _, _), e in g.items():
            per[ats][0] += e['n']
            per[ats][1] += e['minutes']
        for ats, (n, m) in sorted(per.items(), key=lambda kv: -kv[1][1]):
            print(f'{ats:<24}{n:>5} hits{m:>9.0f} min')
        return 0
    return cmd_brief(g, args.target, args.max)


if __name__ == '__main__':
    sys.exit(main())
