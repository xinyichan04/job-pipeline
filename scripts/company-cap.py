#!/usr/bin/env python3
"""Per-company application cap: at most N SUBMITTED applications per company, all runs.
Counts SUBMITTED applications per company across every ledger under $PIPELINE_HOME/runs/.
  company-cap.py check "<Company>"   -> prints count; exit 0 if under cap, 3 if at/over cap
  company-cap.py top [N]             -> companies with most submissions
Cap = config caps.per_company_submitted (default 5); env PIPELINE_COMPANY_CAP overrides."""
import glob, os, re, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402
CAP = int(os.environ.get('PIPELINE_COMPANY_CAP') or PC.cfg('caps.per_company_submitted', 5))
RUNS = PC.runs_dir()
norm = lambda s: re.sub(r'[^a-z0-9 ]', '', re.sub(r'\b(inc|llc|corp|corporation|co|ltd|group|the)\b', '', s.lower())).strip()
def counts():
    c = Counter(); seen = set()
    for f in glob.glob(f'{RUNS}/**/ledger*.md', recursive=True):
        blocks = re.split(r'\n(?=#{2,3} )', open(f, errors='ignore').read())
        for b in blocks:
            m = re.match(r'#{2,3}\s*(?:\d+\.\s*)?(?:key\s+[0-9a-f]{8}\s+[—–-]\s+)?(.+?)\s+[—–-]\s+(.+)', b)
            if not m: continue
            if not re.search(r'(?i)outcome[^a-z\n]*\**\s*submitted', b): continue
            key = re.search(r'key\s*([0-9a-f]{8})', b)
            k = (norm(m.group(1)), key.group(1) if key else m.group(2)[:60].lower())
            if k in seen: continue
            seen.add(k); c[norm(m.group(1))] += 1
        # table / bullet-table rows: "| key8 | Company | Role | ATS | outcome |" or "- key8 | Company | ..."
        for line in open(f, errors='ignore'):
            cells = [x.strip(' *') for x in line.strip().lstrip('-').strip().strip('|').split('|')]
            if len(cells) < 4 or not re.fullmatch(r'[0-9a-f]{8}|\d{1,4}', cells[0]): continue
            if not any(x.lower() == 'submitted' for x in cells[2:7]): continue
            km = re.search(r'\b([0-9a-f]{8})\b', line)
            k = (norm(cells[1]), km.group(1) if km else re.sub(r'\W+', ' ', cells[2].lower())[:60])
            if k in seen: continue
            seen.add(k); c[norm(cells[1])] += 1
    return c
if __name__ == '__main__':
    a = sys.argv[1:]; c = counts()
    if a and a[0] == 'check':
        n = norm(' '.join(a[1:])); v = sum(x for k, x in c.items() if k == n or k.startswith(n + ' ') or n.startswith(k + ' '))
        print(f'{v} submitted (cap {CAP})'); sys.exit(3 if v >= CAP else 0)
    for k, v in c.most_common(int(a[1]) if len(a) > 1 else 25): print(v, k)
