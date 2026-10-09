"""Shared configuration for the Python scripts.

Everything machine- or person-specific lives OUTSIDE the repo, under PIPELINE_HOME
(default ~/.job-pipeline):

    $PIPELINE_HOME/config.json     pipeline policy (copy config.example.json)
    $PIPELINE_HOME/profile.json    the applicant's facts (copy profile.example.json)
    $PIPELINE_HOME/.env            secrets (copy .env.example)
    $PIPELINE_HOME/runs/<date>/    joblists, ledgers, slices
    $PIPELINE_HOME/sessions/       saved ATS session cookies (0700, never commit)

Individual paths can be overridden with PIPELINE_CONFIG, PIPELINE_PROFILE and PIPELINE_ENV.
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def home():
    return os.path.expanduser(os.environ.get("PIPELINE_HOME") or "~/.job-pipeline")


def path(*parts):
    """Path under PIPELINE_HOME."""
    return os.path.join(home(), *parts)


def runs_dir():
    return path("runs")


def _load_json(p, default):
    try:
        with open(p) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def config():
    """config.json merged over config.example.json, so a missing key falls back to the default."""
    base = _load_json(os.path.join(REPO, "config.example.json"), {})
    mine = _load_json(os.environ.get("PIPELINE_CONFIG") or path("config.json"), {})

    def merge(a, b):
        out = dict(a)
        for k, v in b.items():
            out[k] = merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
        return out
    return merge(base, mine)


def cfg(dotted, default=None):
    cur = config()
    for k in dotted.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def profile():
    p = os.environ.get("PIPELINE_PROFILE") or path("profile.json")
    data = _load_json(p, None)
    if data is None:
        raise SystemExit(f"profile not found at {p} - copy profile.example.json there and edit it")
    return data


def env():
    """KEY=VALUE pairs from the .env file, overlaid by the real process environment."""
    out = {}
    for p in (os.environ.get("PIPELINE_ENV"), path(".env"), os.path.join(REPO, ".env")):
        if p and os.path.exists(p):
            for line in open(p):
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
            break
    out.update({k: v for k, v in os.environ.items() if k.isupper()})
    return out


def mailboxes():
    """[(address, app_secret), ...] for every configured mailbox that has credentials (app-specific secret)."""
    e = env()
    out = []
    for mb in cfg("mail.mailboxes", []) or []:
        a, p = e.get(mb.get("address_env", "")), e.get(mb.get("secret_env", ""))
        if a and p:
            out.append((a, p))
    return out


def imap_host():
    return cfg("mail.imap_host", "imap.gmail.com")


def notify(text):
    """Send a message to the human operator.

    Uses NOTIFY_CMD (env or config notify.command): a shell command that receives the
    message on stdin, e.g. a Slack/Discord webhook script or `mail -s pipeline you@host`.
    With nothing configured the message is printed to stderr. Returns True on success.
    """
    cmd = env().get("NOTIFY_CMD") or cfg("notify.command") or ""
    if not cmd:
        print("[notify] " + text, file=sys.stderr)
        return True
    r = subprocess.run(["/bin/sh", "-c", cmd], input=text, text=True, capture_output=True)
    if r.returncode != 0:
        print(f"[notify] command failed ({r.returncode}): {r.stderr.strip()[:200]}", file=sys.stderr)
    return r.returncode == 0
