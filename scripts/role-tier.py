#!/usr/bin/env python3
"""Role-fit tiering for the job pipeline.

Two rules this encodes:
  1. Per-company cap: when a company has more open roles than you want to apply to, take the
     top few in priority order - SWE > infrastructure > backend > data/ML > other CS.
  2. Skip a company entirely if none of its roles are computer-science roles.

Toggles (config.json `roles`): internship_only, exclude_hardware_ece, exclude_analytics,
include_quant, include_research, near_duplicate_family_max. Caps: `caps.per_run_default`
and `caps.per_run_overrides` ({"Company": N}); `--cap N` overrides both.

    python3 role-tier.py <joblist-or-slice.json> [--cap N] [--keep OUT.json] [--drop OUT.json]

Design note (learned the hard way): the first version keyed on "software engineer|developer"
as a PHRASE, so bare "Software Co-op", "Ground Software Intern", "Developer Intern" and
"Compiler Engineer Intern" all fell through to non-CS and would have been discarded. Match the
CS signal on single words, and carve out non-CS with an explicit DENY list rather than trusting
"nothing matched" to mean "not computer science" - an unmatched title is UNKNOWN, not non-CS.
"""
import json, os, re, sys, collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

OPT = {k: PC.cfg('roles.' + k, d) for k, d in (
    ('internship_only', True), ('exclude_hardware_ece', True), ('exclude_analytics', True),
    ('include_quant', True), ('include_research', True), ('near_duplicate_family_max', 2))}

# --- tier 1-5: computer-science roles, in priority order ------------------------------------
SWE = re.compile(r'\b(software|swe|developer|programmer|programming|coding|compiler|'
                 r'full-?stack|application engineer(ing)?|mobile|ios|android)\b', re.I)
INFRA = re.compile(r'\b(infrastructure|sre|site reliability|devops|kubernetes|'
                   r'(platform|systems|cloud|network)\s+(engineer|engineering|intern|developer)|'
                   r'distributed systems)\b', re.I)
BACK = re.compile(r'\b(back-?\s?end|server-?side|\bapi\b|microservice)\b', re.I)
DATA = re.compile(r'\b(data|machine learning|\bml\b|\bai\b|artificial intelligence|analytic|'
                  r'analytics|statistic|quantitative|quant|business intelligence|power bi|'
                  r'agent engineer)\b', re.I)
CS = re.compile(r'\b(front-?end|web|embedded|firmware|qa|automation|algorithm|simulation|'
                r'security|cyber|computer|robotic|fpga|verification|validation|'
                r'information (systems|technology)|\bit\b|digital|technical|technology)\b', re.I)

# --- explicit non-CS: these WIN over a weak CS keyword above --------------------------------
# Only titles that are unambiguously outside computer science belong here.
DENY = re.compile(r'\b(pharmacy|pharmacist|nurse|clinical|reservoir|petroleum|drilling|'
                  r'optical fiber|fiber and cable|aircraft performance|aerodynamic|'
                  r'merchandise|retail|store|sales|marketing|brand|communications|'
                  r'recruit|human resources|people (analytics|operations)|talent|'
                  r'accounting|audit|tax|payroll|procurement|supply chain|logistics|'
                  r'mechanical|chemical|civil|structural|industrial|manufacturing|'
                  r'materials|metallurg|welding|environmental|safety|facilities|'
                  r'product manage(r|ment)|project manage(r|ment)|program manage(r|ment)|'
                  r'business (analyst|analytics|development|operations)|'
                  r'customer (experience|enablement|success)|marine|agronom|'
                  r'device engineering|fab device|analog ic|analog validation|'
                  r'ic design|circuit design|design verification|product engineer(ing)?|'
                  r'electrical (engineer|design)|reservoir|geolog)\b', re.I)

# --- hardware/ECE hard-deny (roles.exclude_hardware_ece) ------------------------------------
# Unlike DENY above, these WIN over every tier including a strong SWE signal: "Software
# Characterization Engineer" at an RF company is an ECE job with a software word in the title,
# and that is exactly the kind of row this filter is for. Embedded / firmware are included
# here; remove them from the regex if you want those roles.
ECE = re.compile(r'\b(electrical|electronics|hardware|semiconductor|silicon|wafer|foundry|'
                 r'\brf\b|radio ?frequency|microwave|antenna|photonic|optoelectronic|'
                 r'analog|mixed[- ]signal|\basic\b|\bvlsi\b|\bfpga\b|\bpcb\b|schematic|'
                 r'power (systems|electronics|conversion)|signal integrity|board design|'
                 r'characterization|chip design|\bsoc design\b|transistor|packaging engineer|'
                 r'embedded|firmware|'
                 r'test engineer(ing)? - (hardware|board)|instrumentation)\b', re.I)

# --- internship gate (roles.internship_only) ------------------------------------------------
# Co-ops count as internships.
INTERN = re.compile(r'\b(intern|interns|internship|co-?op|summer (analyst|associate|scholar|'
                    r'program|student)|student (program|worker|position)|apprentice)\b', re.I)
NONINTERN = re.compile(r'\b(new ?grad(uate)?|entry[- ]level|full[- ]time|experienced|'
                       r'senior|staff|principal|\blead\b|manager|director|'
                       r'rotational program|early career)\b', re.I)


def is_internship(row, blobs=None):
    """-> (bool, why). Title first; a vague title falls back to the JD body."""
    r = row.get('role') or ''
    if INTERN.search(r):
        return True, 'title'
    if NONINTERN.search(r):
        return False, 'title says non-intern'
    b = (blobs or {}).get(row.get('url')) or ''
    if b and len(INTERN.findall(b)) >= 2:
        return True, 'JD body'
    if b:
        return False, 'no internship signal in title or JD'
    return False, 'no internship signal in title (no JD captured)'


# --- data / analytics excluded (roles.exclude_analytics) ------------------------------------
# Genuine ML/AI *engineering* survives; analytics, BI, reporting and
# data-warehouse work does not. MLE wins only when the title also carries an engineering word,
# so "AI Engineer Intern" stays and "Data Analyst Intern" / "Data Science Intern" go.
MLE = re.compile(r'\b(machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|'
                 r'\bnlp\b|computer vision|\bllm\b)\b.{0,30}\b(engineer|engineering|developer|'
                 r'infrastructure|platform|systems|research)\b', re.I)
ANALYTICS = re.compile(r'\b(data|analytic|analytics|analyst|business intelligence|power bi|'
                       r'statistic|quantitative|quant|reporting|warehouse|insights)\b', re.I)

# --- research + quant trading/research (roles.include_research / roles.include_quant). When
# enabled these beat the ANALYTICS exclusion above; a plain
# "Data Analyst" / "Quantitative Analyst - Risk Reporting" still goes. Non-CS research
# (market/UX/user/clinical) stays out via RESEARCH_DENY.
QUANT = re.compile(r'\b(quant(itative)?\s+(trad(er|ing)|research(er)?|developer|dev|'
                   r'strateg(y|ist)|engineer(ing)?|software|analyst)|trad(er|ing)\s+(intern|internship|'
                   r'engineer|analyst|assistant)|\bquant\s+intern|algorithmic trading|'
                   r'(summer|intern)\s+trader|\btrader\b)\b', re.I)
RESEARCH = re.compile(r'\b(research(er)?\s+(scientist|engineer(ing)?|intern(ship)?|assistant|'
                      r'associate|fellow)|researcher|\bresearch\b.{0,20}\b(intern|co-?op))\b', re.I)
RESEARCH_DENY = re.compile(r'\b(market|ux|user|clinical|equity|credit|investment|consumer|'
                           r'policy|economic|survey|medical|biolog|chemi)\w*\s+research', re.I)

TIERS = [(SWE, 1, 'SWE'), (INFRA, 2, 'INFRA'), (BACK, 3, 'BACKEND'),
         (DATA, 4, 'DATA/ML'), (CS, 5, 'OTHER-CS')]

# --- per-company application caps -----------------------------------------------------------
# A few employers document a real ceiling (e.g. TikTok/ByteDance: max 2 per program per period,
# ATS-enforced; Coinbase boilerplate: ~3 per 6 months); verify these yourself before relying on
# them. Everything else gets a self-imposed soft cap (no documented limit, but no evidence that
# unlimited applying is safe either - recruiters can see the full history in Workday/SF).
CAPS = dict(PC.cfg('caps.per_run_overrides', {}) or {})
DEFAULT_CAP = int(PC.cfg('caps.per_run_default', 5))


def tier(role):
    """-> (rank, label). rank 6 = non-CS, rank 7 = title too vague to judge."""
    r = role or ''
    if OPT['exclude_hardware_ece'] and ECE.search(r):
        # Hardware/ECE beats every tier, including a strong SWE title word.
        return (6, 'NON-CS(ECE)')
    if OPT['include_quant'] and QUANT.search(r):
        return (4, 'QUANT')
    if OPT['include_research'] and RESEARCH.search(r) and not RESEARCH_DENY.search(r):
        return (4, 'RESEARCH')
    if OPT['exclude_analytics'] and ANALYTICS.search(r) and not MLE.search(r) and not SWE.search(r):
        # Analytics/BI/data roles are out; genuine ML/AI engineering stays.
        return (6, 'NON-CS(DATA)')
    denied = bool(DENY.search(r))
    for rx, rank, label in TIERS:
        if rx.search(r):
            # A strong software/infra/backend signal beats the deny list ("Software Integration
            # Engineer - Battery Management" is a software job at a car company). A merely weak
            # data/other-CS signal does not ("Retail Analytics", "People Analytics").
            if denied and rank >= 4:
                return (6, 'NON-CS')
            return (rank, label)
    if denied:
        return (6, 'NON-CS')
    return (7, 'UNKNOWN')


# --- JD-text fallback for titles the title alone cannot classify ---------------------------
# Some employers post "Intern - Mountain View, CA" or "Engineering Co-op - <city>";
# both are real software jobs, and both would be thrown away on title alone. So for anything
# that tiers as UNKNOWN, read the captured JD text and decide on keyword density.
JD_SWE = re.compile(r'\b(software|c\+\+|python|java|javascript|golang|\bgit\b|coding|'
                    r'programming|scripting|script|codebase|algorithm)\b', re.I)
JD_CS = re.compile(r'\b(computer science|sql|database|api|linux|cloud|scada|\bplc\b|\bhmi\b|'
                   r'\bdcs\b|automation|data structures)\b', re.I)


def load_jds():
    import glob
    blobs = {}
    for f in glob.glob(os.path.join(PC.runs_dir(), '*', 'alljds.json')):
        try:
            for r in json.load(open(f)):
                if r.get('url') and r.get('blob'):
                    blobs.setdefault(r['url'], r['blob'])
        except Exception:
            continue
    return blobs


def tier_with_jd(row, blobs):
    """Tier by title; if the title is UNKNOWN, fall back to the JD body."""
    rank, label = tier(row.get('role'))
    if rank != 7:
        return rank, label
    b = blobs.get(row.get('url')) or ''
    if not b:
        return 7, 'UNKNOWN(no JD)'
    swe, cs = len(JD_SWE.findall(b)), len(JD_CS.findall(b))
    if swe >= 6:
        return 1, 'SWE(by JD)'
    if swe + cs >= 6:
        return 5, 'OTHER-CS(by JD)'
    return 6, 'NON-CS(by JD)'


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    src = args[0]
    cap = None   # None = use CAPS / DEFAULT_CAP per company
    keep_out = drop_out = None
    for i, a in enumerate(args):
        if a == '--cap' and i + 1 < len(args):
            cap = int(args[i + 1])
        if a == '--keep' and i + 1 < len(args):
            keep_out = args[i + 1]
        if a == '--drop' and i + 1 < len(args):
            drop_out = args[i + 1]

    rows = json.load(open(src))
    blobs = load_jds()

    # Internship gate - runs BEFORE tiering so a non-internship never occupies one of a
    # company's capped slots.
    nonintern = []
    kept_rows = []
    for x in rows:
        ok, why = is_internship(x, blobs) if OPT['internship_only'] else (True, '')
        if ok:
            kept_rows.append(x)
        else:
            x['notes'] = (x.get('notes') or '') + (
                f' | NON-INTERNSHIP ({why}) - dropped by the internship-only rule.')
            nonintern.append(x)
    rows = kept_rows

    T = {}   # url -> (rank,label), title first then JD fallback
    for x in rows:
        T[id(x)] = tier_with_jd(x, blobs)
    tt = lambda x: T[id(x)]
    by = collections.defaultdict(list)
    for x in rows:
        by[x['company']].append(x)

    keep, drop, skipped_co, unknown = [], [], [], []
    for co, rs in sorted(by.items()):
        co_cap = cap if cap is not None else CAPS.get(co, DEFAULT_CAP)
        ranked = sorted(rs, key=lambda x: (tt(x)[0], x['role']))
        cs = [x for x in ranked if tt(x)[0] <= 5]
        unknown += [x for x in ranked if tt(x)[0] == 7]
        if not cs:
            # Rule 2: nothing computer-science-shaped here -> skip the company entirely.
            skipped_co.append(co)
            drop += ranked
            continue
        # Near-duplicate guard: 5 "Engineering Co-op - <city>" rows are ONE job posted five
        # times. Applying to every copy reads as shotgunning, so keep at most 2 of a family.
        def fam(r):
            r = re.sub(r'\s*[-,(]\s*(summer|spring|fall|winter)?\s*20\d\d.*$', '', r or '', flags=re.I)
            r = re.sub(r'\s*[-,(].{0,26}$', '', r).strip().lower()
            return re.sub(r'[^a-z ]+', '', r)
        seen = collections.Counter()
        deduped = []
        for x in cs:
            f = fam(x['role'])
            if seen[f] >= int(OPT['near_duplicate_family_max']):
                x['notes'] = (x.get('notes') or '') + (
                    f' | NEAR-DUPLICATE: extra copy of "{f}" at {co} (same role, different location) '
                    f'- dropped to avoid shotgunning one posting.')
                drop.append(x)
                continue
            seen[f] += 1
            deduped.append(x)
        cs = deduped
        why = ('documented employer limit' if co in CAPS else 'soft cap, no documented limit')
        for x in cs[:co_cap]:
            lbl = tt(x)[1]
            x['notes'] = (x.get('notes') or '') + (
                f" | ROLE PRIORITY {lbl}: top-{min(co_cap, len(cs))} of {len(cs)} CS roles open "
                f"at {co}; cap {co_cap} ({why}). Per-company cap + CS-only rule.")
        keep += cs[:co_cap]
        drop += cs[co_cap:] + [x for x in ranked if tt(x)[0] > 5]

    W = sys.stdout.write
    W(f'\nROLE TIERING  {src}\n')
    W(f'  in: {len(rows)} rows / {len(by)} companies   '
      f'cap={cap if cap is not None else "per-company (default %d)" % DEFAULT_CAP}, CS-only, internship-only, ECE excluded\n')
    W(f'  KEEP {len(keep)}   DROP {len(drop)}   companies skipped entirely: {len(skipped_co)}\n')
    if nonintern:
        W(f'\n  NON-INTERNSHIP, dropped before tiering ({len(nonintern)}):\n')
        for x in nonintern[:40]:
            W(f'    - {x["company"][:24]:24} | {(x.get("role") or "")[:52]}\n')
        if len(nonintern) > 40:
            W(f'    ... and {len(nonintern)-40} more\n')
    W(f'  tier mix kept: {collections.Counter(tt(x)[1] for x in keep).most_common()}\n')
    if skipped_co:
        W(f'\n  SKIPPED COMPANIES (no CS-shaped role):\n')
        for co in skipped_co:
            W(f'    - {co}: ' + '; '.join(x['role'][:44] for x in by[co][:4]) + '\n')
    if unknown:
        W(f'\n  !! TITLE TOO VAGUE TO JUDGE - review by JD, not title ({len(unknown)}):\n')
        for x in unknown:
            W(f'    - {x["company"][:24]:24} | {x["role"][:52]}\n')
    W('\n  KEPT, by company:\n')
    for co in sorted({x['company'] for x in keep}):
        W(f'    {co[:26]:26} ' + ' | '.join(
            f'[{tt(x)[1]}] {x["role"][:34]}' for x in keep if x['company'] == co) + '\n')

    if keep_out:
        json.dump(keep, open(keep_out, 'w'), indent=1)
        W(f'\nwrote {keep_out} ({len(keep)})\n')
    if drop_out:
        json.dump(drop + nonintern, open(drop_out, 'w'), indent=1)
        W(f'wrote {drop_out} ({len(drop) + len(nonintern)})\n')


if __name__ == '__main__':
    main()
