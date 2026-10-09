#!/usr/bin/env python3
"""Deterministic Stage-1 prescreen for the job pipeline.

Applies ONLY the eligibility checks that the SWElist/Simplify feed answers with
structured fields. Prose-only facts (security clearance, GPA floors,
school-specific programs) are left to the agent's TRIAGE read of the JD.

Why this exists: on one early run, 21 Bachelor's-eligible postings at one employer
were dropped as "PhD required" because its boilerplate says "whether you're an
undergrad or a PhD student". Keyword-matching JD prose for degree level is
unsafe; the feed's `degrees` field is authoritative and free.

Design rule: never drop on a guess. A missing/empty field means
UNSTATED, which always keeps the row.

The rules come from config.json `eligibility` (see config.example.json):
    degree_codes_ok        feed degree codes the applicant qualifies for (1 = Bachelor's)
    earliest_term          [year, season] - season codes 1 Winter, 2 Spring, 3 Summer, 4 Fall
    extra_terms_ok         extra [year, season] pairs accepted even if before earliest_term
                           (Simplify tags one Dec/Jan winter as both "Winter Y" and "Winter Y+1")
    allowed_countries      e.g. ["US", "Canada"]; postings elsewhere are FLAGGED
    drop_outside_allowed_countries   true = drop them instead of flagging

Usage:
    prescreen.py <alljds.json> [--json out.json]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

# Feed enums, decoded from a 305-posting corpus.
SEASON_NAME = {1: "Winter", 2: "Spring", 3: "Summer", 4: "Fall"}
DEGREE_NAME = {int(k): v for k, v in (PC.cfg("eligibility.degree_names") or
               {"1": "Bachelor's", "2": "Master's", "3": "MBA", "4": "JD", "5": "PhD"}).items()}
DEGREES_OK = set(PC.cfg("eligibility.degree_codes_ok", [1]) or [1])
BACHELORS = 1  # kept for callers that tag "Bachelor's OK"

EARLIEST = tuple(PC.cfg("eligibility.earliest_term", [2027, 2]))  # (year, season code)
WINTERS_OK = {tuple(t) for t in (PC.cfg("eligibility.extra_terms_ok", []) or [])}
ALLOWED = [c.strip() for c in (PC.cfg("eligibility.allowed_countries", ["US"]) or [])]
DROP_OUTSIDE = bool(PC.cfg("eligibility.drop_outside_allowed_countries", False))


def term_ok(seasons):
    """True if any listed term is one the applicant can take."""
    if not seasons:
        return True, "term unstated"
    best = None
    for s in seasons:
        if not s or len(s) < 2:
            continue
        code, year = s[0], s[1]
        if (year, code) >= EARLIEST or (year, code) in WINTERS_OK:
            return True, ""
        if best is None or (year, code) > best:
            best = (year, code)
    if best is None:
        return True, "term unparseable"
    y, c = best
    return False, f"latest term {SEASON_NAME.get(c, c)} {y} is before the configured window (earliest {SEASON_NAME.get(EARLIEST[1], EARLIEST[1])} {EARLIEST[0]})"


def degree_ok(degrees):
    """Authoritative degree check. Empty == unstated == keep.

    An undecoded code is NOT a licence to drop: codes 6/9/10 appear alongside
    Bachelor's on other postings, so their meaning is unknown and at least one
    (code 9) was a real SWE intern role. Unknown code -> keep and
    let the agent read the JD.
    """
    if not degrees:
        return True, "degree unstated"
    if DEGREES_OK & set(degrees):
        return True, ""
    unknown = [d for d in degrees if d not in DEGREE_NAME]
    if unknown:
        codes = ", ".join(str(d) for d in unknown)
        return True, f"undecoded degree code {codes} — verify on the JD"
    named = ", ".join(DEGREE_NAME[d] for d in degrees)
    return False, f"requires {named}; none of the accepted degree levels"


COUNTRY_ALIASES = {
    "US": ["USA", "United States", ", US"],
    "Canada": ["Canada", ", CAN", ", CA, Canada"],
    "UK": ["United Kingdom", "UK", "England", "London"],
}


def in_allowed(locs):
    """True if any location is in an allowed country, False if none is, None if unstated."""
    if not locs:
        return None  # unstated
    needles = []
    for c in ALLOWED:
        needles += COUNTRY_ALIASES.get(c, [c])
    for l in locs:
        ls = l.rstrip()
        if "remote" in ls.lower() and "US" in ALLOWED and "," not in ls:
            return True
        for n in needles:
            if (n.startswith(", ") and ls.endswith(n)) or (not n.startswith(", ") and n.lower() in ls.lower()):
                return True
    return False


is_us = in_allowed  # backwards-compatible name


def screen(row):
    """Return (verdict, reason, flags). verdict in keep|drop."""
    flags = []

    if row.get("active") is False:
        return "drop", "posting no longer active", flags

    ok, why = degree_ok(row.get("degrees"))
    if not ok:
        return "drop", why, flags
    if why.startswith("undecoded"):
        flags.append(why)

    ok, why = term_ok(row.get("seasons"))
    if not ok:
        return "drop", why, flags

    # Outside the allowed countries: flag by default (work authorization must be checked
    # against profile.json), drop only when drop_outside_allowed_countries is set.
    ok_loc = in_allowed(row.get("locs"))
    if ok_loc is False:
        if DROP_OUTSIDE:
            return "drop", f"location: not in {'/'.join(ALLOWED)}", flags
        flags.append(f"OUTSIDE {'/'.join(ALLOWED)}: verify work authorization before applying")

    return "keep", "", flags


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    rows = json.load(open(args[0]))

    kept, dropped = [], []
    for r in rows:
        verdict, reason, flags = screen(r)
        out = dict(r)
        out.pop("blob", None)  # keep output small
        out["prescreen_flags"] = flags
        if verdict == "keep":
            kept.append(out)
        else:
            out["prescreen_drop_reason"] = reason
            dropped.append(out)

    nonus = sum(1 for r in kept if r["prescreen_flags"])
    print(f"in:      {len(rows)}")
    print(f"kept:    {len(kept)}  ({nonus} flagged, still need a check)")
    print(f"dropped: {len(dropped)}")
    print()
    by_reason = {}
    for r in dropped:
        by_reason.setdefault(r["prescreen_drop_reason"], []).append(r)
    for reason, rs in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        print(f"  {len(rs):3}  {reason}")

    if "--json" in sys.argv:
        dest = sys.argv[sys.argv.index("--json") + 1]
        json.dump({"kept": kept, "dropped": dropped}, open(dest, "w"), indent=1)
        print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
