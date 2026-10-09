# Résumé tailor

`tailor.py` takes one job description and produces a one-page PDF of your LaTeX résumé tuned to it:
skills the JD asks for move to the front, and (optionally) Experience/Projects bullets are reworded
in the JD's vocabulary by an LLM under code-enforced guard rails. Every tailored version is a git
branch in your résumé repo, so the branch history is the record of what was sent where.

## Résumé repo layout

Point `tailor.resume_repo` in `$PIPELINE_HOME/config.json` (or env `RESUME_REPO`) at a git repo with:

| file | purpose |
|---|---|
| `resume.tex` | the résumé. Bullets between `\section*{WORK EXPERIENCE}` and `\input{skills.tex}` may be rewritten; the line before each `\begin{itemize}` is that block's heading |
| `skills.tex` | the Skills section (`\textbf{Programming:}`, `\textbf{Technologies:}` rows), fully regenerated per JD |
| `skills-bank.json` | every skill you actually have (`resume` = always listed, `evidenced` = listed when the JD asks) |
| `experience-bank.json` | optional: confirmed extra facts per role, `vetoed` clauses, and a log of `inferred_used` clauses |

Branches:

| branch | use |
|---|---|
| `main` | general SWE (also used for the `swe` track if there is no `swe` branch) |
| `infra`, `ai`, `finance` | optional track variants; the closest one is picked per JD |
| `tailored/<company>-<role>-<date>` | one per application, branched off the chosen track |

`examples/` holds a fake "Jane Doe" résumé and banks with the expected schema.

## How scoring works

Every skill in `lexicon.json` (plus bank aliases) found in the JD gets a weight from the section it
appears in: requirements x3, preferred x1.5, other x1, "what you'll learn"/benefits x0.5, with a line's
own lead word ("Required", "Preferred") overriding, and +0.25 per repeat. The company's own name is never
counted. The score is the weight of JD skills present in the résumé text divided by the total JD weight.
It is a transparent keyword-coverage number, not a prediction of any real ATS.

## How bullet rewriting is guarded

The LLM (`tailor.llm_cmd`, default: the Claude Code CLI) gets the JD, the bullets and your confirmed
extra facts. Its output is then checked in code:

- same bullets, same order; the first bullet of each role (the summary) stays first and is never dropped;
- any number not already in that bullet (or in a confirmed fact used for it) rejects the rewrite, and the original bullet is kept;
- bullets over 320 characters are rejected;
- `vetoed` facts are passed as "never claim";
- the result must fit on one page: least-relevant non-summary bullets are dropped, and if it still does not fit, all originals are restored.

Employer, title, dates, education and headings are never touched. Disable rewriting with
`--no-rewrite` or `tailor.rewrite_bullets: false`.

## Honesty

You must read every tailored résumé before it is sent. The guard rails stop invented numbers, not
misleading wording. With `tailor.add_unlisted_jd_skills: false` (the default) nothing outside your
skills bank is ever added; if you turn it on, the added skills are listed under
`jd_added_verify_you_have_these` in the report, and you are claiming them.

## Quickstart

```bash
mkdir ~/resume && cd ~/resume && git init -b main
cp <repo>/tailor/examples/resume.tex <repo>/tailor/examples/skills.tex .
cp <repo>/tailor/examples/skills-bank.example.json skills-bank.json
cp <repo>/tailor/examples/experience-bank.example.json experience-bank.json
git add . && git commit -m "base résumé"

python3 <repo>/tailor/tailor.py track --jd jd.txt
python3 <repo>/tailor/tailor.py score --jd jd.txt
pbpaste | python3 <repo>/tailor/tailor.py tailor --jd - --company "Acme" --role "SWE Intern" --dry-run
```

Requires `tectonic` on PATH for `tailor` (not for `score`/`track`). Track signals can be extended per
track with config `tailor.track_signals` (lexicon keys or `bank:<display>`).
