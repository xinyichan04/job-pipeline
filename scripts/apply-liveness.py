#!/usr/bin/env python3
"""
Join liveness-probe.py results back onto a queue and emit the applier-ready queue.

  python3 apply-liveness.py <queue.json> <liveness.json> \
      --keep queue-live.json [--drop queue-dead.json]

Rules (deliberately conservative -- a wrongly dropped row is a job never applied to):
  * closed / expired  -> dropped, with the reason recorded on the row
  * unknown           -> KEPT. An unreachable probe is not evidence a posting is dead.
  * open              -> kept
Every kept row gains `ats_url` (the resolved real ATS link) when the probe found one, so the
applier can navigate straight there instead of bouncing through the aggregator.

Original queue order and row indices are preserved on `orig_index`, because the ledger and the
nightly task may refer to rows by their position in the source queue.
"""
import argparse
import collections
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("queue")
    ap.add_argument("liveness")
    ap.add_argument("--keep", required=True)
    ap.add_argument("--drop")
    args = ap.parse_args()

    rows = json.load(open(args.queue))
    probes = {p["key"]: p for p in json.load(open(args.liveness)) if p.get("key")}

    keep, drop = [], []
    tally = collections.Counter()
    unprobed = 0

    for i, row in enumerate(rows):
        r = dict(row)
        r["orig_index"] = i
        p = probes.get(row.get("key"))
        if not p:
            unprobed += 1
            r["liveness"] = "unprobed"
            keep.append(r)
            tally["unprobed(kept)"] += 1
            continue

        verdict = p.get("verdict", "unknown")
        r["liveness"] = verdict
        r["liveness_checked_at"] = p.get("checked_at")
        if p.get("ats_url"):
            r["ats_url"] = p["ats_url"]
        if p.get("ats_http") is not None:
            r["ats_http"] = p["ats_http"]
        if p.get("live_title"):
            r["live_title"] = p["live_title"]

        if verdict in ("closed", "expired"):
            r["drop_reason"] = p.get("note") or f"liveness={verdict}"
            drop.append(r)
            tally[verdict] += 1
        else:
            keep.append(r)
            tally[f"{verdict}(kept)"] += 1

    json.dump(keep, open(args.keep, "w"), indent=1)
    if args.drop:
        json.dump(drop, open(args.drop, "w"), indent=1)

    print(f"in:   {len(rows)}")
    for k in sorted(tally):
        print(f"  {k:18} {tally[k]}")
    print(f"kept: {len(keep)}  -> {args.keep}")
    print(f"dead: {len(drop)}" + (f"  -> {args.drop}" if args.drop else ""))
    if unprobed:
        print(f"note: {unprobed} row(s) had no probe result and were kept unfiltered")

    with_ats = sum(1 for r in keep if r.get("ats_url"))
    print(f"kept rows carrying a resolved ATS url: {with_ats}/{len(keep)}")


if __name__ == "__main__":
    main()
