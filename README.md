# job-pipeline

An LLM-agent pipeline for internship / new-grad job applications:

1. **Ingest** a daily job-list email (SWE List / Simplify digest) into a structured job list.
2. **Triage** it deterministically: degree level, term, active status, location, role type,
   per-company caps, duplicates.
3. **Apply** through the real ATS (Greenhouse, Workday, Ashby, Lever, SuccessFactors,
   iCIMS, Oracle...) in a headed browser, several workers in parallel, with
   label-addressed form drivers and optional human-like pacing.
4. **Tailor** a one-page LaTeX résumé to each job description before upload.
5. **Reconcile** the ledgers: verify every submission against the inbox, account for every
   posting, and summarise for the human.

Humans stay in the loop for everything that matters: captchas and bot walls are handed to
you (never solved), facts that are not in your profile park the application instead of
being guessed, and final submission sits behind an explicit on/off gate.

> Status: extracted from a working personal setup and generalised. Expect to adapt
> selectors and rules to the ATS tenants you meet. Use at your own risk.

## Architecture

```
            ┌───────────────┐      ┌──────────────────────────────┐      ┌───────────────┐
 job-list   │  Stage 1      │ joblist.json + tenant-grouped slices │      │  Stage 3      │
 email ───► │  jd-list      │ ───► │  Stage 2  job-applier  × N   │ ───► │  jd-reconcile │ ──► summary
 (IMAP)     │  LIST+TRIAGE  │      │  own Chrome per worker       │      │  LEDGER       │     (notify)
            └───────────────┘      │  form.js / greenhouse.js /   │      └───────────────┘
              curl only            │  workday.js + tailor.py      │       inbox verify,
                                   │  ledger-part<i>.md           │       coverage, teardown
                                   └──────────────────────────────┘
```

- **Stage 1 (`agents/jd-list.md`)** runs alone, never opens a browser. `fetch-jds.py`
  pulls each posting's structured fields (`__NEXT_DATA__`) in parallel; `prescreen.py`
  drops only on those fields; `role-tier.py` ranks/filters by title; `next-batch.js
  --slices N` splits the queue so every posting on one ATS host goes to one worker (a
  tenant-wide login gate is then met once, not once per worker).
- **Stage 2 (`agents/job-applier.md`)** runs N instances in parallel, each with its own
  headed Chrome profile and CDP port (`bin/pipeline-chrome -i <i>`), its own form cache and
  its own ledger part. No shared mutable state between workers.
- **Stage 3 (`agents/jd-reconcile.md`)** merges ledger parts by posting key
  (`ledger-merge.py`), checks confirmation emails, follows up on action emails
  (`inbox-actions.py`), and stops the browsers unless a human challenge is still open.

The agent prompts are written for Claude Code subagents but are plain Markdown; adapt the
frontmatter for any agent runtime. An orchestrator (you, or a parent agent) runs Stage 1,
spawns N appliers on the slices, then runs Stage 3.

## Repository layout

| Path | What |
|---|---|
| `agents/` | The three stage prompts (templates) and an example per-run briefing |
| `scripts/` | All pipeline scripts (Python 3.9+, Node 18+ ESM) |
| `scripts/pipeline_config.py`, `scripts/pipeline-config.js` | Shared config/paths/notify |
| `tailor/` | Résumé tailoring tool, skill lexicon, fake example résumé |
| `bin/pipeline-chrome` | Isolated headed Chrome instances (one per worker) |
| `bin/show-tab` | Bring the tab that needs a human to the front |
| `config.example.json` | Pipeline policy (terms, degree, caps, role filters, mail, notify) |
| `profile.example.json` | Applicant facts (fake "Jane Doe"); the only source of form answers |
| `.env.example` | Secret keys (names only) |

### Scripts by stage

| Stage | Scripts |
|---|---|
| Ingest | `swelist-arrived.py` (cheap "has today's email arrived"), `swelist-digest.py` (digest + top-N notification), `inbox-scan.py`, `fetch-jds.py`, `pipeline-check.cjs` |
| Triage | `prescreen.py`, `role-tier.py`, `liveness-probe.py` + `apply-liveness.py` (open/closed check without a browser), `worked-keys.py`, `preslice.py` (all deterministic pre-spawn filtering) |
| Queue | `next-batch.js` (what is still owed across all runs; `--slices N --slice i`) |
| Apply | `form.js`, `greenhouse.js`, `workday.js`, `pace.js`, `gh-fill.sh`, `gh-pick.sh`, `sf-pick.sh`, `session-store.js`, `autosubmit.js`, `challenge.js`, `inbox-code.py`, `ats-brief.py`, `issues.js` |
| Ledger | `ledger-merge.py`, `already-applied.py`, `company-cap.py`, `inbox-actions.py` |
| Tailor | `tailor/tailor.py` + `tailor/lexicon.json` |

## Setup

Requirements: macOS or Linux, Python 3.9+, Node 18+,
[`agent-browser`](https://www.npmjs.com/package/agent-browser) (`npm i -g agent-browser`),
Chrome or Chrome for Testing, `curl`. For tailoring: `git` and
[`tectonic`](https://tectonic-typesetting.github.io/) (and an LLM CLI if you enable bullet
rewriting; the default is the Claude Code CLI).

```bash
git clone <this repo> job-pipeline && cd job-pipeline
export PIPELINE_HOME=~/.job-pipeline            # all personal data and run state live here
mkdir -p "$PIPELINE_HOME" && chmod 700 "$PIPELINE_HOME"
cp config.example.json  "$PIPELINE_HOME/config.json"   # policy: edit terms, degree, caps, mail
cp profile.example.json "$PIPELINE_HOME/profile.json"  # YOUR facts: replace every value
cp .env.example         "$PIPELINE_HOME/.env"          # secrets: mailbox app secret, ATS creds
chmod 600 "$PIPELINE_HOME/.env" "$PIPELINE_HOME/profile.json"

python3 scripts/swelist-arrived.py                     # mailbox reachable?
bin/pipeline-chrome start                              # base browser; sign in to things once
```

Nothing personal is ever read from the repository itself: config, profile, secrets,
ledgers, session cookies and challenge records all live under `PIPELINE_HOME`, and the
`.gitignore` blocks them in case you point `PIPELINE_HOME` at the repo.

### Daily run (orchestrated by hand or by a parent agent)

```bash
# Stage 1
<run agents/jd-list.md>               # writes $PIPELINE_HOME/runs/<date>/joblist.json + slices
# Stage 2: one per slice, in parallel
bin/pipeline-chrome -i 1 start ; bin/pipeline-chrome -i 2 start
<run agents/job-applier.md with i=1, slice-0.json>  &  <... i=2, slice-1.json>
# Stage 3
<run agents/jd-reconcile.md>
```

### Submit gate

```bash
node scripts/autosubmit.js status
echo "on  # <date> <who>" > "$PIPELINE_HOME/AUTOSUBMIT"   # allow end-to-end submission
rm "$PIPELINE_HOME/AUTOSUBMIT"                             # back to fill-and-park
```

With the flag absent every application is filled, screenshotted and parked as
`awaiting-approval` for you to review. There is deliberately no command that turns it on;
it is a file you create yourself.

### Notifications

Set `NOTIFY_CMD` (in `.env`) to any shell command that reads a message on stdin, e.g. a
script that posts to a Slack/Discord webhook or `mail -s job-pipeline you@example.com`.
Unset, messages go to stderr. Used by `challenge.js` (captcha handoffs) and
`swelist-digest.py`.

## How pacing works (`PIPELINE_PACE=1`)

`scripts/pace.js` is an opt-in layer used by `form.js`. When it is off, every pause is a
no-op and text entry/clicks are a plain agent-browser `fill`/`click`. When on:

- **Between fields:** a log-normal pause with a ~1 s median (clamped 0.6-3.2 s), plus an
  ~8% chance of a longer 2.5-4 s "reading" pause. Short 80-400 ms micro-pauses separate
  the steps of a single interaction.
- **Pointer travel:** before a click or text entry the pointer glides to a random point
  inside the element's box in 2-4 eased, slightly jittered hops. If this agent-browser
  build cannot report a box or move the mouse, it hovers the element instead and keeps
  doing so for the rest of the run.
- **Typing:** the field is clicked and cleared (select-all + Backspace), then the value is
  typed as real keystrokes in 1-6 character chunks with variable gaps, slightly longer
  after spaces and punctuation. Whether to type at the element or via the keyboard is
  probed once per run and cached.
- **Never throws:** failures come back as `{ ok: false, out: <message> }` for the caller
  to handle; batch fills in `form.js` re-scan the form afterwards to verify values.

**Scope:** pacing targets *passive* scorers that read event cadence (instant programmatic
fills, zero mouse travel, metronomic timing), such as ATS spam scores and invisible
risk-scoring. It does **not** solve and is not meant to defeat explicit challenges
(hCaptcha, reCAPTCHA puzzles, Cloudflare/Akamai/DataDome walls). Those are parked for a
human. There is no fingerprint spoofing and no solver service anywhere in this repo.

## How tailoring works

`tailor/tailor.py` works on your own résumé, kept as LaTeX in a git repo
(`config.tailor.resume_repo`; see `tailor/README.md` and `tailor/examples/`):

1. **Extract** every skill the JD names using `lexicon.json` plus aliases from your
   `skills-bank.json`, weighted by section: requirements ×3, preferred ×1.5, other ×1,
   "what you'll learn"/benefits ×0.5, +0.25 per repeat. The company's own name never counts.
2. **Pick a track** branch (`swe` / `infra` / `ai` / `finance`) by signal strength.
3. **Rewrite bullets** (optional, LLM): Experience/Projects bullets are reworded in the
   JD's vocabulary, with guard rails enforced in code, not just in the prompt: same bullets
   in the same order, the summary bullet stays first, **no number that is not already in
   that bullet or a fact you confirmed**, bounded length, vetoed facts are never claimed.
   Any violation keeps your original bullet.
4. **Reorder skills**: JD-requested skills from your bank move to the front. With
   `add_unlisted_jd_skills: false` (the default) nothing outside your bank is ever added.
5. **Fit one page**: compile with tectonic; drop the least JD-relevant bullets/skills until
   it fits. Layout and font sizes never change.
6. **Score** before/after (keyword coverage, the same thing ATS keyword filters key on),
   commit to a `tailored/<company>-<role>-<date>` branch, print JSON with the PDF path.

You are responsible for every word on a tailored résumé. Review the branch diff, and keep
`add_unlisted_jd_skills` off unless you really have those skills.

## Ethics and responsible use

- **Never solves captchas.** Captchas, "verify you are human" walls and human-only
  sign-ins are recorded with `challenge.js park`, you are notified, and the worker moves
  on. You clear them in the visible pipeline browser. There is no solver integration and
  there must never be one.
- **Human in the loop.** Final submission is gated by a file only you create; challenges,
  missing facts and certification statements are parked for you; the reconcile stage
  tells you exactly what went out and what is waiting.
- **Facts are yours to verify.** Every answer must trace to `profile.json`. Agents may
  select and phrase, never invent. Read what was submitted in your name (essays are logged
  verbatim in the ledger) and correct the profile when something is wrong.
- **Don't spam employers.** Per-company caps, duplicate detection, near-duplicate
  collapsing and a time box per posting are on by default. Apply only to roles you would
  accept.
- **Comply with each site's Terms of Service.** Some job boards and ATS vendors restrict
  automated access. You are responsible for checking and respecting the terms of every
  site you use this with, and for the accuracy of every application.
- **Credentials and cookies stay local.** `session-store.js` writes cookies 0600 under
  `PIPELINE_HOME/sessions/`, never prints values, and the directory is git-ignored.

## License

MIT, see [LICENSE](LICENSE).
