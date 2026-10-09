#!/usr/bin/env python3
"""
Browser-free liveness probe for a backfill queue.

Why this exists: the nightly task assumed "needs a browser per JD for open/closed".
It doesn't. Simplify's posting page ships the full record in __NEXT_DATA__, including
`jobPosting.active`, and /jobs/click/<key> 302s to the real ATS URL. Two cheap HTTP
requests per row replace a whole browser session, and the resolved ATS URL is worth
keeping on the row anyway -- it saves the applier a hop later.

Output is a sidecar JSON keyed by row `key`, written incrementally, so the run is
resumable and safe to interrupt (which matters: this shares a box with live appliers).

  python3 liveness-probe.py <queue.json> -o <out.json> [--limit N] [--workers 3]

Verdicts:
  open      simplify active AND ats url reachable (2xx/3xx)
  closed    simplify active=false, or ATS returned 404/410
  expired   simplify page itself 404s (posting pulled from the index)
  unknown   network/parse failure -- treated as OPEN by consumers; never auto-dropped
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request

# Some python.org builds ship no system trust store, so every https call fails
# with CERTIFICATE_VERIFY_FAILED unless certifi is wired in explicitly.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context()

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

_print_lock = threading.Lock()
_write_lock = threading.Lock()


def get(url, timeout=25, method="GET"):
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX)


def probe_simplify(key):
    """-> (verdict_hint, active, title, company) from the posting page."""
    url = f"https://simplify.jobs/p/{key}"
    try:
        with get(url) as r:
            html = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            return "expired", None, None, None
        return "unknown", None, None, None
    except Exception:
        return "unknown", None, None, None

    m = NEXT_DATA.search(html)
    if not m:
        return "unknown", None, None, None
    try:
        jp = json.loads(m.group(1))["props"]["pageProps"]["jobPosting"]
    except Exception:
        return "unknown", None, None, None

    active = jp.get("active")
    job = jp.get("job") or {}
    title = job.get("title") or jp.get("title")
    company = (job.get("company") or {}).get("name")
    if active is False:
        return "closed", False, title, company
    return "open", active, title, company


def probe_ats(key):
    """Resolve the click-through and report where it lands. -> (url, http_code)."""
    url = f"https://simplify.jobs/jobs/click/{key}"
    try:
        with get(url) as r:
            return r.geturl(), r.status
    except urllib.error.HTTPError as e:
        return (e.url if hasattr(e, "url") else None), e.code
    except Exception:
        return None, None


def probe_row(row, delay):
    time.sleep(delay)
    key = row.get("key")
    out = {
        "key": key,
        "company": row.get("company"),
        "role": row.get("role"),
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    if not key:
        out["verdict"] = "unknown"
        out["note"] = "row has no key"
        return out

    verdict, active, title, company = probe_simplify(key)
    out["simplify_active"] = active
    if title:
        out["live_title"] = title
    if company:
        out["live_company"] = company

    if verdict in ("expired", "closed"):
        out["verdict"] = verdict
        return out

    ats_url, code = probe_ats(key)
    out["ats_url"] = ats_url
    out["ats_http"] = code
    if code in (404, 410):
        out["verdict"] = "closed"
        out["note"] = f"ATS returned {code}"
    elif code is None:
        # Simplify says active; we just couldn't reach the ATS. Do not drop it.
        out["verdict"] = "unknown" if verdict == "unknown" else "open"
        out["note"] = "ATS unreachable from probe"
    else:
        out["verdict"] = verdict
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("queue")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--delay", type=float, default=0.7,
                    help="per-request politeness delay, seconds")
    args = ap.parse_args()

    rows = json.load(open(args.queue))
    if args.limit:
        rows = rows[:args.limit]

    done = {}
    if os.path.exists(args.out):
        try:
            done = {r["key"]: r for r in json.load(open(args.out)) if r.get("key")}
        except Exception:
            done = {}
    todo = [r for r in rows if r.get("key") not in done]
    with _print_lock:
        print(f"{len(rows)} rows, {len(done)} already probed, {len(todo)} to go",
              file=sys.stderr)

    results = list(done.values())

    def flush():
        with _write_lock:
            tmp = args.out + ".tmp"
            with open(tmp, "w") as f:
                json.dump(results, f, indent=1)
            os.replace(tmp, args.out)

    n = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(probe_row, r, args.delay): r for r in todo}
        for fut in cf.as_completed(futs):
            res = fut.result()
            results.append(res)
            n += 1
            with _print_lock:
                print(f"[{n}/{len(todo)}] {res['verdict']:8} "
                      f"{(res.get('company') or '?')[:28]:28} "
                      f"{(res.get('role') or '')[:44]}", file=sys.stderr)
            if n % 10 == 0:
                flush()
    flush()

    tally = {}
    for r in results:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    print("\n== verdicts ==", file=sys.stderr)
    for k in sorted(tally):
        print(f"  {k:8} {tally[k]}", file=sys.stderr)
    print(f"written: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
