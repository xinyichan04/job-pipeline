#!/usr/bin/env python3
"""Bulk-fetch Simplify postings to get their structured fields.

Stage 1, step 2. Takes the email rows (company / role / url) and fetches each
posting's `__NEXT_DATA__` payload in parallel, producing the `degrees` /
`seasons` / `active` / `locs` fields that `prescreen.py` needs, plus the prose
`blob` the agent reads for clearance / GPA / school-specific facts.

The structured fields are NOT in the SWElist email — this step is what creates
them, so it must run before prescreen.

Usage:
    fetch-jds.py joblist-raw.json alljds.json [--workers 10]
                 [--carryover PATH] [--no-carryover]

Merges $PIPELINE_HOME/CARRYOVER.json (postings owed from an earlier run) into the input rows
before fetching, unless --no-carryover is passed.
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_config as PC  # noqa: E402

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")

BLOB_KEYS = ("description", "requirements", "additional_requirements",
             "desirable", "responsibilities", "title")


def fetch(row):
    for _ in range(2):
        try:
            html = subprocess.run(
                ["curl", "-sL", "--max-time", "25", "-A", UA, row["url"]],
                capture_output=True, text=True, timeout=40).stdout
            m = re.search(
                r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
                html, re.S)
            if not m:
                continue
            jp = json.loads(m.group(1))["props"]["pageProps"]["jobPosting"]
            blob = " ".join(str(jp.get(k) or "") for k in BLOB_KEYS)
            return {**row,
                    "seasons": jp.get("seasons"),
                    "degrees": jp.get("degrees"),
                    "locs": [l.get("value") for l in (jp.get("locations") or [])],
                    "sponsors_h1b": jp.get("sponsors_h1b"),
                    "active": jp.get("active"),
                    "ats": jp.get("ats"),
                    "jd_title": jp.get("title"),
                    "skills": [s.get("name") for s in (jp.get("skills") or [])],
                    "blob": re.sub(r"<[^>]+>", " ", blob)}
        except Exception:
            pass
    return {**row, "fetch_failed": True}


DEFAULT_CARRYOVER = PC.path("CARRYOVER.json")


def merge_carryover(rows, path):
    """Fold CARRYOVER.json rows into the day's email rows.

    Postings owed from an earlier run do NOT come back on their own: the
    SWElist email lists only that day's new postings, so a posting wrongly
    dropped once is lost forever unless it is carried. This lived only as a
    prose step in SKILL.md, which an agent can skip; doing it here makes it
    unskippable, because this script must run before prescreen.

    Dedupes on url against the email rows. Returns (rows, merged, skipped).
    """
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return rows, [], []
    seen = {r.get("url") for r in rows}
    merged, skipped = [], []
    for row in doc.get("rows") or []:
        if not all(row.get(k) for k in ("company", "role", "url")):
            skipped.append(row)
            continue
        if row["url"] in seen:
            skipped.append(row)
            continue
        seen.add(row["url"])
        merged.append({"company": row["company"], "role": row["role"],
                       "url": row["url"],
                       "carryover_from_run": row.get("from_run")})
    return rows + merged, merged, skipped


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.exit(__doc__)
    src, dest = args[0], args[1]
    workers = 10
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])

    rows = json.load(open(src))

    if "--no-carryover" not in sys.argv:
        carryover_path = DEFAULT_CARRYOVER
        if "--carryover" in sys.argv:
            carryover_path = sys.argv[sys.argv.index("--carryover") + 1]
        rows, merged, skipped = merge_carryover(rows, carryover_path)
        for row in merged:
            print(f"carryover merged: {row['company']} — {row['role']}")
        for row in skipped:
            print(f"carryover skipped (already present or malformed): "
                  f"{row.get('company', '?')} — {row.get('role', '?')}")

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(fetch, rows))
    json.dump(res, open(dest, "w"), indent=1, default=str)

    failed = [r for r in res if r.get("fetch_failed")]
    print(f"fetched {len(res) - len(failed)} / {len(rows)}  (failed: {len(failed)})")
    if failed:
        # A failed fetch has no structured fields, so prescreen keeps it as
        # "unstated" — correct per the never-drop-on-a-guess rule, but it means
        # the agent must read these JDs by hand.
        print("\nfailed (no structured fields; prescreen will keep them as unstated):")
        for r in failed:
            print(f"  {r.get('company','?')[:24]:24} {r.get('role','?')[:48]}")


if __name__ == "__main__":
    main()
