#!/usr/bin/env python3
"""Tailor a LaTeX résumé to a job description, keep it to one page, score it, commit it to a branch.

    tailor.py tailor --jd JD.txt --company "Acme" --role "SWE Intern" [--track auto|swe|infra|ai|finance]
                     [--push] [--dry-run] [--no-rewrite]
    tailor.py score  --jd JD.txt [--branch main]        ATS-style keyword score of a branch vs a JD
    tailor.py track  --jd JD.txt                        which track branch fits the JD

The résumé lives in its own git repo (config tailor.resume_repo, or env RESUME_REPO) holding
resume.tex, skills.tex, skills-bank.json and optionally experience-bank.json. See tailor/README.md
and tailor/examples/.

What `tailor` does:
  1. Reads the JD and finds every skill it names (lexicon.json next to this file, plus aliases from
     skills-bank.json), weighted by where it appears: requirements x3, preferred x1.5, other x1,
     "what you'll learn"/benefits x0.5, +0.25 per repeat. The company's own name is never a skill.
  2. Picks the closest track branch (infra / ai / finance / swe) unless --track is given.
  3. Optionally (tailor.rewrite_bullets) rewrites each Experience/Projects bullet in the JD's vocabulary
     through an LLM (tailor.llm_cmd). Guard rails ENFORCED IN CODE, not just requested in the prompt:
       - same bullets, same order, same ids; the first bullet under each heading (the role summary)
         stays first and is never dropped;
       - a rewritten bullet may not contain any number that is not already in that bullet or in a
         confirmed experience-bank fact used for it (no invented metrics) -> otherwise the original
         bullet is kept;
       - bounded length (<= 320 chars) -> otherwise the original is kept;
       - facts listed under "vetoed" in experience-bank.json are passed as never_claim;
       - the page must still fit on one page; least-relevant non-summary bullets are dropped to fit,
         and if it still does not fit, all original bullets are restored.
     Employer, title, dates, education and section headers are never touched (only \\item text).
  4. Rewrites skills.tex on a new branch tailored/<company>-<role>-<date> off that track: skills the
     JD asks for move to the front. Only skills from skills-bank.json are used, unless
     tailor.add_unlisted_jd_skills is true (then JD skills outside the bank are added and listed under
     "jd_added_verify_you_have_these" in the report).
  5. Compiles with tectonic; if it spills past one page, drops the least JD-relevant skills until it fits.
     Font sizes and layout never change.
  6. Scores the base track and the tailored version, commits the branch (pushes only with --push or
     tailor.push_branches), and copies the PDF to <out_dir>/<branch>/<pdf_name>.

Prints one JSON object; "pdf" is the file to upload. --jd - reads the JD from stdin.
Safe to run from parallel appliers (one run at a time via a file lock).

The score is a transparent keyword-coverage score: sum of weights of JD skills found anywhere in the
résumé text / sum of all JD skill weights. YOU are responsible for reviewing every tailored résumé
before it is sent: the tool rephrases, it does not verify that the rephrasing is true.
"""
import argparse, ctypes, ctypes.util, datetime as dt, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import pipeline_config as PC  # noqa: E402

REPO = os.path.expanduser(os.environ.get("RESUME_REPO") or PC.cfg("tailor.resume_repo", "~/resume"))
LEX = json.load(open(os.path.join(HERE, "lexicon.json")))
OUT = os.path.expanduser(PC.cfg("tailor.out_dir", "/tmp/job-pipeline-tailored"))
LOCK = os.path.join(REPO, "build", ".tailor.lock")
PDF_NAME = PC.cfg("tailor.pdf_name", "Resume.pdf")
TRACKS = tuple(PC.cfg("tailor.tracks", ["swe", "infra", "ai", "finance"]))
LLM_CMD = PC.cfg("tailor.llm_cmd", ["claude", "-p", "--model", "opus", "--output-format", "json"])
ADD_UNLISTED = bool(PC.cfg("tailor.add_unlisted_jd_skills", False))
PUSH_DEFAULT = bool(PC.cfg("tailor.push_branches", False))
EXP_BANK = os.path.join(REPO, "experience-bank.json")


def _git_env():
    """Commit identity: tailor.git_author_name/email if set, else the résumé repo's own git config."""
    e = dict(os.environ)
    name, mail = PC.cfg("tailor.git_author_name", ""), PC.cfg("tailor.git_author_email", "")
    if name:
        e["GIT_AUTHOR_NAME"] = e["GIT_COMMITTER_NAME"] = name
    if mail:
        e["GIT_AUTHOR_EMAIL"] = e["GIT_COMMITTER_EMAIL"] = mail
    return e


GIT_ENV = _git_env()


def _load_bank():
    p = os.path.join(REPO, "skills-bank.json")
    if not os.path.exists(p):
        raise SystemExit(f"skills-bank.json not found in résumé repo {REPO} (set tailor.resume_repo or RESUME_REPO)")
    return json.load(open(p))


BANK = _load_bank()


# ------------------------------------------------------------------ matching

def _alias_re(a):
    # Word boundaries that also work for tokens ending/starting in symbols (C++, C#, .NET, Node.js):
    # an alphanumeric edge needs a non-alphanumeric neighbour; a symbol edge needs whitespace/punctuation.
    lead = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", a) else r"(?<!\S)"
    tail = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", a) else r"(?![^\s,.;:)/])"
    return lead + re.escape(a) + tail


# Python's re needs fixed-width look-behinds; these three lexicon patterns use variable-width ones.
_SEP = r"(?:(?<=[,/])|(?<=[,/] )|(?<=[,/]  ))"
PY_PATTERNS = {
    "c": r"\bC(?=\s*[,/]\s*(?:C\+\+|Java|Python|Rust|Go|C#|Fortran)|\s+(?:programming|language)\b|\s+(?:and|or)\s+(?:C\+\+|Rust|Python|Java|assembly))"
         r"|(?:(?<=C\+\+[,/])|(?<=C\+\+[,/] )|(?<=C\+\+ [,/] ))C\b"
         r"|(?:(?<=embedded )|(?<=\bin )|(?<=with )|(?<=using ))C\b(?=[\s,.)])",
    "go": r"\bGolang\b|\bGo\b(?=\s*[,/)]|\s+(?:programming|language|lang)\b|\s+(?:and|or)\s+[A-Z])"
          r"|" + _SEP + r"Go\b|(?:(?<=\bin )|(?<=with )|(?<=using )|(?<=\bof ))Go\b",
    "r": r"\bR\b(?=\s*[,/)]|\s+(?:programming|language|studio|shiny)\b|\s+(?:and|or)\s+[A-Z])|" + _SEP + r"R\b",
}


def build_terms():
    """term key -> compiled regex. Lexicon entries plus bank-only aliases."""
    terms = {}
    for e in LEX["entries"]:
        if e.get("pattern"):
            terms[e["name"]] = re.compile(PY_PATTERNS.get(e["name"], e["pattern"]))
        else:
            terms[e["name"]] = re.compile("|".join(_alias_re(a) for a in e.get("aliases", [e["name"]])), re.I)
    for row in BANK["rows"].values():
        for s in row:
            if s.get("aliases"):
                key = "bank:" + s["display"]
                terms[key] = re.compile("|".join(_alias_re(a) for a in s["aliases"]), re.I)
    return terms


TERMS = build_terms()


def bank_keys(s):
    lex = s.get("lex") or []
    keys = [lex] if isinstance(lex, str) else list(lex)
    if s.get("aliases"):
        keys.append("bank:" + s["display"])
    return keys


REQ_H = re.compile(r"(required|minimum|basic|must[- ]have|what you('ll)? (need|bring)|you bring|requirements|qualifications|"
                   r"who you are|you have|you'll have|what we expect|ideal candidate|looking for|skills|about you)", re.I)
PREF_H = re.compile(r"(preferred|nice[- ]to[- ]have|bonus|plus|desired|ideally)", re.I)
LEARN_H = re.compile(r"(what you('ll| will)? (learn|gain)|you('ll| will) learn|we offer|benefits|perks|compensation)", re.I)
OTHER_H = re.compile(r"(responsibilit|what you('ll| will)? do|about (us|the)|the role|day to day|teams?/work|focus areas)", re.I)
LINE_REQ = re.compile(r"^\W*(required|must|excellent|strong|proficien)", re.I)
LINE_PREF = re.compile(r"^\W*(preferred|bonus|nice|plus|desired|recommended|familiarity)", re.I)
URL = re.compile(r"https?://\S+|www\.\S+")


def jd_weights(jd, company=""):
    """term -> weight. The heading above a line sets its multiplier: requirements x3, preferred x1.5,
    responsibilities/other x1, 'what you'll learn'/benefits x0.5. A line's own lead word ("Required",
    "Preferred", "Bonus") overrides. Each repeat adds 0.25. The company's own name is never a skill."""
    weights, section = {}, 1.0
    own = re.compile(_alias_re(company.strip()), re.I) if company.strip() else None
    for line in jd.splitlines():
        s = URL.sub(" ", line).strip()
        if not s:
            continue
        if len(s) < 70 and not s.startswith(("-", "*", "•")):
            if LEARN_H.search(s):
                section = 0.5
            elif PREF_H.search(s):
                section = 1.5
            elif REQ_H.search(s):
                section = 3.0
            elif OTHER_H.search(s):
                section = 1.0
            elif s.isupper() or s.endswith(":"):
                section = 1.0
        w = 3.0 if LINE_REQ.search(s) else 1.5 if LINE_PREF.search(s) else section
        if section == 0.5 and not LINE_REQ.search(s):
            w = 0.5
        for k, rx in TERMS.items():
            hits = rx.findall(s)
            if not hits or (own and all(own.fullmatch(h if isinstance(h, str) else h[0]) for h in hits)):
                continue
            weights[k] = max(weights.get(k, 0), w) + (0.25 * len(hits) if k in weights else 0.25 * (len(hits) - 1))
    return weights


# ------------------------------------------------------------------ résumé text / score

def plain(tex):
    tex = re.sub(r"(?<!\\)%.*", "", tex)
    tex = tex.replace(r"\#", "#").replace(r"\_", "_").replace(r"\%", "%").replace(r"\&", "&")
    tex = re.sub(r"\\href\{[^}]*\}", "", tex)
    tex = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?", " ", tex)
    return re.sub(r"[{}$]", " ", tex)


def resume_text(tree):
    main = open(os.path.join(tree, "resume.tex")).read()
    body = main[main.index(r"\begin{document}"):]
    body = body.replace(r"\input{skills.tex}", open(os.path.join(tree, "skills.tex")).read())
    return plain(body)


def score(text, weights):
    present = {k for k in weights if TERMS[k].search(text)}
    total = sum(weights.values()) or 1
    return round(100 * sum(weights[k] for k in present) / total, 1), present


def pretty(k):
    return k[5:] if k.startswith("bank:") else k


# ------------------------------------------------------------------ tracks
# Signals are lexicon keys (or "bank:<display>" for bank-only aliases). Override per track with
# config tailor.track_signals = {"infra": [...], ...} to add skills specific to your own bank.

TRACK_SIGNALS = {
    "infra": ["linux", "tcp/ip", "kubernetes", "docker", "aws", "gcp", "microsoft azure", "terraform", "c++", "c",
              "rust", "go", "hpc", "devops"],
    "ai": ["pytorch", "tensorflow", "large language models", "rag", "hugging face", "nlp", "computer vision",
           "numpy", "pandas", "scikit-learn", "jax", "cuda", "langchain", "embeddings", "keras", "mlflow"],
    "finance": [],
}
TRACK_SIGNALS.update(PC.cfg("tailor.track_signals", {}) or {})
TRACK_WORDS = {
    "infra": r"\b(distributed systems?|infrastructure|low[- ]latency|kernel|networking|systems programming|reliability|SRE|platform)\b",
    "ai": r"\b(machine learning|deep learning|\bML\b|\bAI\b|LLMs?|model training|inference|data science)\b",
    "finance": r"\b(trading|fintech|quant\w*|market data|exchange|hedge fund|financial|payments?|banking|capital markets)\b",
}


def pick_track(jd, weights):
    sc = {}
    for t in ("infra", "ai", "finance"):
        if t not in TRACKS:
            continue
        sc[t] = sum(weights.get(k, 0) for k in TRACK_SIGNALS.get(t, [])) + 1.5 * len(re.findall(TRACK_WORDS[t], jd, re.I))
    if not sc:
        return "swe", sc
    best = max(sc, key=sc.get)
    return (best if sc[best] >= 4 else "swe"), sc


# ------------------------------------------------------------------ skills.tex

ROW_LABEL = {"programming": "Programming", "technologies": "Technologies"}


def row_items(skills_tex, label):
    m = re.search(r"\\textbf\{%s:\}\s*(.*)" % label, skills_tex)
    return [x.strip() for x in m.group(1).split(",")] if m else []


DISPLAY = {"aws": "AWS", "gcp": "GCP", "microsoft azure": "Azure", "nlp": "NLP", "rag": "RAG", "cuda": "CUDA",
           "langchain": "LangChain", "kubernetes": "Kubernetes", "go": "Go", "sql": "SQL", "nosql": "NoSQL",
           "graphql": "GraphQL", "grpc": "gRPC", "fastapi": "FastAPI", "node.js": "Node.js", "vue": "Vue",
           "scikit-learn": "scikit-learn", "hugging face": "Hugging Face", "large language models": "LLMs",
           "html/css": "HTML/CSS", "ci-cd": "CI/CD", "rest api": "REST APIs", "tcp/ip": "TCP/IP", "http": "HTTP",
           "json": "JSON", "mqtt": "MQTT", "ssh": "SSH", "hpc": "HPC", "etl": "ETL", "dbt": "dbt", "ios": "iOS",
           "swiftui": "SwiftUI", "mysql": "MySQL", "sqlite": "SQLite", "dynamodb": "DynamoDB", "bigquery": "BigQuery",
           "mlflow": "MLflow", "onnx": "ONNX", "llvm": "LLVM", "gdb": "GDB", "cmake": "CMake", "vs code": "VS Code",
           "pytest": "pytest", "objective-c": "Objective-C", "c#": "C\\#", "c++": "C++", "php": "PHP",
           "matlab": "MATLAB", "sap": "SAP", "fpga": "FPGA", "amazon sqs": "Amazon SQS", "jax": "JAX",
           "xgboost": "XGBoost", "openshift": "OpenShift", "vector databases": "Vector Databases",
           ".net": ".NET", "react native": "React Native", "unreal engine": "Unreal Engine", "ros": "ROS",
           "qt": "Qt", "r": "R", "c": "C", "sql server": "SQL Server", "freertos": "FreeRTOS", "ollama": "Ollama"}
LEX_CAT = {e["name"]: e["cat"] for e in LEX["entries"]}


def disp(name):
    return DISPLAY.get(name, name.title() if name.islower() and " " in name else name[:1].upper() + name[1:])


def plan_rows(track_skills_tex, weights, add_missing=False):
    """row -> ordered list of (entry, JD weight, base position). Bank entries with status 'resume' always,
    'evidenced' ones only if the JD asks for them. With add_missing (config tailor.add_unlisted_jd_skills),
    JD skills outside the bank are ALSO added (status 'jd-added'): languages to Programming, the rest
    to Technologies. Off by default: only list skills you actually have."""
    rows = {}
    covered = {k for row in BANK["rows"].values() for e in row for k in bank_keys(e)}
    for row, entries in BANK["rows"].items():
        base_order = row_items(track_skills_tex, ROW_LABEL[row])
        chosen = []
        for s in entries:
            w = max([weights.get(k, 0) for k in bank_keys(s)] or [0])
            if s["status"] == "resume" or w > 0:
                pos = base_order.index(s["display"]) if s["display"] in base_order else 999
                chosen.append((s, w, pos))
        if add_missing:
            for k, w in weights.items():
                if k in covered or k.startswith("bank:") or w <= 0:
                    continue
                if (LEX_CAT.get(k) == "language") == (row == "programming"):
                    chosen.append(({"display": disp(k), "status": "jd-added", "lex": k}, w, 500))
        chosen.sort(key=lambda x: (-x[1], x[2]))
        rows[row] = chosen
    return rows


def render(rows):
    lines = ["% SKILLS section: the ONLY part the tailoring system rewrites.", r"\section*{SKILLS}", r"\begin{itemize}"]
    for row, items in rows.items():
        lines.append(r"  \item \textbf{%s:} %s" % (ROW_LABEL[row], ", ".join(s["display"] for s, _, _ in items)))
    if BANK.get("languages_spoken"):
        lines.append(r"  \item \textbf{Language:} " + BANK["languages_spoken"])
    lines += [r"\end{itemize}", ""]
    return "\n".join(lines)


# ------------------------------------------------------------------ bullets
BULLET_RE = re.compile(r"^(\s*\\item\s+)(.*)$")
SECTION_START, SECTION_END = r"\section*{WORK EXPERIENCE}", r"\input{skills.tex}"


def bullet_blocks(tex):
    """Each itemize block between WORK EXPERIENCE and the skills input:
    {"heading", "begin", "end" (line indexes of \\begin/\\end{itemize}), "items": [text, ...], "prefix"}."""
    lines = tex.split("\n")
    live = lambda l: not l.lstrip().startswith("%")  # noqa: E731 -- ignore markers inside comments
    a = next(i for i, l in enumerate(lines) if SECTION_START in l and live(l))
    b = next(i for i, l in enumerate(lines) if SECTION_END in l and live(l))
    blocks, header, cur = [], "", None
    for i in range(a, b):
        l = lines[i]
        if l.strip().startswith(r"\begin{itemize}"):
            cur = {"heading": header, "begin": i, "items": [], "prefix": "  \\item "}
        elif l.strip().startswith(r"\end{itemize}") and cur is not None:
            cur["end"] = i
            blocks.append(cur)
            cur = None
        elif cur is not None:
            m = BULLET_RE.match(l)
            if m:
                cur["prefix"] = m.group(1)
                cur["items"].append(m.group(2))
        elif l.strip() and not l.strip().startswith("%"):
            header = plain(l).strip()
    return lines, blocks


def tex_escape(s):
    s = s.replace("\\", "")
    for c in "%&#_$":
        s = re.sub(r"(?<!\\)" + re.escape(c), "\\\\" + c, s)
    return s


NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def log_inferred(heading, clause, company, role):
    """Inferred clauses (inherent to the work, not separately confirmed) that went onto a résumé are logged
    to experience-bank.json "inferred_used" for periodic human review. A rejected clause belongs in
    "vetoed"; the prompt is then told never to claim it again."""
    try:
        bank = json.load(open(EXP_BANK))
        bank.setdefault("inferred_used", []).append({"heading": heading, "fact": clause, "for": f"{company}: {role}",
                                                     "date": dt.date.today().isoformat()})
        json.dump(bank, open(EXP_BANK, "w"), indent=1, ensure_ascii=False)
    except Exception:  # noqa: BLE001 -- best-effort log
        pass


def call_llm(prompt):
    """Run tailor.llm_cmd with the prompt on stdin. Accepts a JSON envelope {"result": "..."} (Claude Code
    CLI --output-format json) or raw text; returns the first {...} JSON object found in the result."""
    r = subprocess.run(LLM_CMD, input=prompt, capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError(f"llm_cmd exited {r.returncode}: {r.stderr.strip()[:200]}")
    out = r.stdout
    try:
        env = json.loads(out)
        if isinstance(env, dict) and isinstance(env.get("result"), str):
            out = env["result"]
        elif isinstance(env, dict) and "bullets" in env:
            return env
    except ValueError:
        pass
    return json.loads(out[out.index("{"):out.rindex("}") + 1])


def rewrite_bullets(base_tex, jd, weights, company, role):
    """Rewrites Experience/Projects bullets for the JD. Returns (render, changes, error):
    render(k) -> tex with the k least-relevant non-summary bullets dropped (for page fit).
    On any failure render(0) returns the original text. Guard rails are listed in the module docstring."""
    lines, blocks = bullet_blocks(base_tex)
    bank_all = json.load(open(EXP_BANK)) if os.path.exists(EXP_BANK) else {}
    bank, vetoed = bank_all.get("entries", []), bank_all.get("vetoed", [])
    bank = [e for e in bank if e.get("confirmed", True)]
    keywords = [pretty(k) for k, _ in sorted(weights.items(), key=lambda x: -x[1])][:40]
    orig, payload = {}, []
    for bi, blk in enumerate(blocks):
        items = []
        for t in blk["items"]:
            oid = f"o{len(orig)}"
            orig[oid] = (bi, plain(t).strip())
            items.append({"id": oid, "text": orig[oid][1]})
        extra = [{"id": "b:" + e["id"], "fact": e["fact"]} for e in bank
                 if e["heading"].lower() in blk["heading"].lower()]
        payload.append({"heading": blk["heading"], "bullets": items, "confirmed_extra_facts": extra,
                        "never_claim": [v["fact"] for v in vetoed if v["heading"].lower() in blk["heading"].lower()]})
    unchanged = lambda k=0: base_tex  # noqa: E731
    prompt = (
        "You tailor résumé bullets for one specific job so they pass an ATS / recruiter screen.\n"
        f"Job: {role} at {company}.\n\nJOB DESCRIPTION:\n{jd[:12000]}\n\n"
        f"JD keywords by weight (highest first): {', '.join(keywords)}\n\n"
        "RÉSUMÉ SECTIONS (each heading's bullets in order, plus extra facts the candidate CONFIRMED are true for "
        "that heading):\n" + json.dumps(payload, ensure_ascii=False, indent=1) +
        "\n\nRules:\n"
        "1. Keep EVERY bullet, in the SAME order and with the same id. The first bullet under each heading is the "
        "summary of the role (what the candidate mainly did) and must stay first and stay a summary.\n"
        "2. Rewrite each bullet in the JD's vocabulary, but stay CLOSE to the original: keep its core subject, "
        "main system and main result recognisable; weave in the JD's key phrases only where they truthfully "
        "describe the work; don't recast it as a different kind of work.\n"
        "3. Format: start with a strong past-tense achievement verb, 'achieved X by doing Y'; add 'validated by Z' "
        "only when the bullet or a fact gives real evidence (simulator, verifier, benchmark, load test, adoption, "
        "user scale). Never invent validation.\n"
        "4. Confirmed extra facts: if one matches the JD, APPEND it as a short trailing clause to the most related "
        "bullet under the same heading; the bullet's main point must still lead. List the fact ids you used in "
        "that bullet's 'extras'. Don't create new bullets.\n"
        "4b. If no confirmed fact fits but the JD stresses something that is a NATURAL, INHERENT part of doing that "
        "bullet's own work (testing, debugging, monitoring, profiling, documenting or code-reviewing the SAME "
        "system), you may append one such short clause per bullet, only when genuinely natural. It must not add a "
        "new system, tool, metric, team or responsibility, and never anything in that heading's never_claim list. "
        "Put 'inferred:<the clause>' in that bullet's 'extras'.\n"
        "5. No number/percentage/metric that isn't in that bullet or its extras; name a technology only if the "
        "bullet, its heading or its extras involve it; each bullet <= ~270 characters; plain text.\n"
        "6. drop_priority: ALL non-first bullet ids, least JD-relevant first (used only if the page overflows).\n"
        'Output ONLY JSON: {"bullets": {"o0": {"text": "...", "extras": []}, ...}, "drop_priority": ["o7", ...]}'
    )
    try:
        full = call_llm(prompt)
        new, drop_prio = full["bullets"], full.get("drop_priority") or []
    except Exception as e:  # noqa: BLE001 -- any failure keeps the original bullets
        return unchanged, [], f"bullet rewrite failed: {type(e).__name__}: {str(e)[:200]}"
    bank_by_id = {"b:" + e["id"]: e for e in bank}
    firsts = {f"o{sum(len(b['items']) for b in blocks[:bi])}" for bi in range(len(blocks))}
    final, changes = {}, []
    for oid, (bi, old) in orig.items():
        nb = new.get(oid) or {}
        txt = (nb.get("text") or "").strip()
        ex = [x for x in nb.get("extras") or [] if x in bank_by_id
              and bank_by_id[x]["heading"].lower() in blocks[bi]["heading"].lower()]
        inferred = [x for x in nb.get("extras") or [] if isinstance(x, str) and x.startswith("inferred:")]
        ex += inferred
        allowed = set(NUM_RE.findall(old)).union(*[set(NUM_RE.findall(bank_by_id[x]["fact"])) for x in ex if x in bank_by_id])
        bad = set(NUM_RE.findall(txt)) - allowed
        if not txt or bad or len(txt) > 320:
            final[oid] = old
            changes.append({"heading": blocks[bi]["heading"], "source": oid,
                            "rejected": f"new numbers {sorted(bad)}" if bad else "empty/too long"})
            continue
        final[oid] = txt
        for x in inferred:
            log_inferred(blocks[bi]["heading"], x[9:].strip(), company, role)
        changes.append({"heading": blocks[bi]["heading"], "source": oid, "extras": ex, "before": old, "after": txt})
    drop_prio = [d for d in drop_prio if d in orig and d not in firsts]
    drop_prio += [o for o in orig if o not in firsts and o not in drop_prio]   # anything the model omitted

    def render_tex(k=0):
        gone = set(drop_prio[:k])
        out = list(lines)
        for bi in reversed(range(len(blocks))):
            blk = blocks[bi]
            ids = [o for o, (b2, _) in orig.items() if b2 == bi and o not in gone]
            out[blk["begin"] + 1:blk["end"]] = [blk["prefix"] + tex_escape(final[o]) for o in ids]
        return "\n".join(out)
    render_tex.drop_prio = drop_prio
    render_tex.orig = orig
    return render_tex, changes, None


# ------------------------------------------------------------------ build / pages

def _pages_coregraphics(path):
    lib = ctypes.util.find_library("CoreGraphics")
    if not lib:
        return None
    cg = ctypes.cdll.LoadLibrary(lib)
    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_bool]
    cg.CGPDFDocumentCreateWithURL.restype = ctypes.c_void_p
    cg.CGPDFDocumentCreateWithURL.argtypes = [ctypes.c_void_p]
    cg.CGPDFDocumentGetNumberOfPages.restype = ctypes.c_size_t
    cg.CGPDFDocumentGetNumberOfPages.argtypes = [ctypes.c_void_p]
    p = os.path.abspath(path).encode()
    url = cf.CFURLCreateFromFileSystemRepresentation(None, p, len(p), False)
    doc = cg.CGPDFDocumentCreateWithURL(url)
    return cg.CGPDFDocumentGetNumberOfPages(doc) if doc else None


def pdf_pages(path):
    """Page count: macOS CoreGraphics, else pypdf, else `pdfinfo`, else a raw '/Type /Page' count."""
    try:
        n = _pages_coregraphics(path)
        if n:
            return n
    except Exception:  # noqa: BLE001
        pass
    try:
        from pypdf import PdfReader  # type: ignore
        return len(PdfReader(path).pages)
    except Exception:  # noqa: BLE001
        pass
    if shutil.which("pdfinfo"):
        r = subprocess.run(["pdfinfo", path], capture_output=True, text=True)
        m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
        if m:
            return int(m.group(1))
    data = open(path, "rb").read()
    return len(re.findall(rb"/Type\s*/Page(?![s\w])", data))


def compile_pdf(tree):
    tectonic = shutil.which("tectonic")
    if not tectonic:
        raise SystemExit("tectonic not found on PATH: install it (https://tectonic-typesetting.github.io) to compile résumés")
    out = os.path.join(tree, "build")
    os.makedirs(out, exist_ok=True)
    r = subprocess.run([tectonic, "-o", out, "resume.tex"], cwd=tree, capture_output=True, text=True)
    pdf = os.path.join(out, "resume.pdf")
    if r.returncode or not os.path.exists(pdf):
        raise SystemExit("tectonic failed:\n" + r.stderr[-1500:])
    return pdf, pdf_pages(pdf)


def git(*a, cwd=REPO, check=True):
    r = subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, env=GIT_ENV)
    if check and r.returncode:
        raise SystemExit(f"git {' '.join(a)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def slug(s, n=30):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n].strip("-")


def show(branch, path):
    return git("show", f"{branch}:{path}")


# ------------------------------------------------------------------ commands

def read_jd(path):
    return sys.stdin.read() if path == "-" else open(path).read()


def base_branch(track):
    if track != "swe" and git("branch", "--list", track):
        return track
    if track == "swe" and git("branch", "--list", "swe"):
        return "swe"
    return "main" if git("branch", "--list", "main") else git("rev-parse", "--abbrev-ref", "HEAD")


def cmd_tailor(a):
    import fcntl
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    jd = read_jd(a.jd)
    lock = open(LOCK, "w")
    fcntl.flock(lock, fcntl.LOCK_EX)        # parallel appliers: git worktrees/refs are shared state
    if len(jd.strip()) < 200:
        raise SystemExit("JD text too short (<200 chars): pass the full job description")
    weights = jd_weights(jd, a.company)
    track, track_scores = (a.track, None) if a.track != "auto" else pick_track(jd, weights)
    base = base_branch(track)
    base_tex = show(base, "resume.tex")
    if a.no_rewrite or not PC.cfg("tailor.rewrite_bullets", True):
        new_tex, changes, rw_err = (lambda k=0: base_tex), [], "disabled"
    else:
        lock.close()                      # LLM call outside the lock
        new_tex, changes, rw_err = rewrite_bullets(base_tex, jd, weights, a.company, a.role)
        lock = open(LOCK, "w")
        fcntl.flock(lock, fcntl.LOCK_EX)

    date = dt.date.today().strftime("%Y%m%d")
    branch = f"tailored/{slug(a.company, 20)}-{slug(a.role)}-{date}"
    if git("branch", "--list", branch):
        branch += "-" + dt.datetime.now().strftime("%H%M%S")
    tree = os.path.join(REPO, "build", "wt", slug(branch, 80))
    if os.path.exists(tree):
        git("worktree", "remove", "--force", tree, check=False)
    git("worktree", "add", "-q", "-b", branch, tree, base)
    try:
        base_text = resume_text(tree)
        base_score, _ = score(base_text, weights)
        resume_path = os.path.join(tree, "resume.tex")
        dropped_bullets = []
        if changes:
            # page fit: drop least JD-relevant non-summary bullets until the rewritten bullets fit on one page
            for k in range(len(getattr(new_tex, "drop_prio", [])) + 1):
                open(resume_path, "w").write(new_tex(k))
                if compile_pdf(tree)[1] == 1:
                    dropped_bullets = [new_tex.orig[o][1][:80] for o in new_tex.drop_prio[:k]]
                    break
            else:
                open(resume_path, "w").write(base_tex)
                changes, rw_err = [], "bullet rewrite could not fit one page; originals kept"
        else:
            open(resume_path, "w").write(new_tex(0))

        rows = plan_rows(open(os.path.join(tree, "skills.tex")).read(), weights, add_missing=ADD_UNLISTED)
        dropped = []
        while True:
            open(os.path.join(tree, "skills.tex"), "w").write(render(rows))
            pdf, pages = compile_pdf(tree)
            if pages == 1:
                break
            # drop the least relevant skill: lowest JD weight, latest position, technologies first
            cands = [(w, -i, r) for r in ("technologies", "programming") if r in rows for i, (s, w, _) in enumerate(rows[r])]
            if not cands:
                raise SystemExit("cannot fit on one page")
            w, negi, r = min(cands)
            dropped.append(rows[r].pop(-negi)[0]["display"])

        new_text = resume_text(tree)
        new_score, present = score(new_text, weights)
        bank_all = {k for row in BANK["rows"].values() for s in row for k in bank_keys(s)}
        missing = sorted((k for k in weights if k not in present), key=lambda k: -weights[k])
        report = {
            "company": a.company, "role": a.role, "track": track, "track_scores": track_scores,
            "branch": branch, "base": base, "score_before": base_score, "score_after": new_score,
            "jd_skills": {pretty(k): round(w, 2) for k, w in sorted(weights.items(), key=lambda x: -x[1])},
            "added_from_bank": [s["display"] for r in rows.values() for s, w, _ in r if s["status"] == "evidenced"],
            "dropped_for_space": dropped,
            "jd_added_verify_you_have_these": [s["display"] for r in rows.values() for s, w, _ in r if s["status"] == "jd-added"],
            "missing_in_bank": [pretty(k) for k in missing if k in bank_all],
            "missing_not_in_bank": [pretty(k) for k in missing if k not in bank_all],
            "score_max_possible": round(100 * sum(w for k, w in weights.items() if k in present or k in bank_all) / (sum(weights.values()) or 1), 1),
            "pages": 1,
            "bullets_rewritten": sum(1 for c in changes if "after" in c),
            "bank_extras_used": sorted({x for c in changes for x in c.get("extras", []) if x.startswith("b:")}),
            "inferred_extras_used": [x[9:] for c in changes for x in c.get("extras", []) if x.startswith("inferred:")],
            "dropped_bullets_for_space": dropped_bullets,
            "bullet_changes": changes,
            "bullet_rewrite_error": rw_err,
        }
        if a.dry_run:
            report["pdf"] = pdf
            report["skills_tex"] = open(os.path.join(tree, "skills.tex")).read()
            git("worktree", "remove", "--force", tree)
            git("branch", "-D", branch)
            print(json.dumps(report, indent=1, ensure_ascii=False))
            return

        git("add", "skills.tex", "resume.tex", cwd=tree)
        # --allow-empty: skills already a full match for the JD leaves nothing to commit, which is still a valid tailoring
        git("commit", "-q", "--allow-empty", "-m", f"Tailor for {a.company}: {a.role} (ATS score {base_score} -> {new_score})", cwd=tree)
        dest = os.path.join(OUT, slug(branch, 80))
        os.makedirs(dest, exist_ok=True)
        shutil.copy(pdf, os.path.join(dest, PDF_NAME))
        report["pdf"] = os.path.join(dest, PDF_NAME)
        if a.push or PUSH_DEFAULT:
            r = subprocess.run(["git", "push", "-q", "origin", branch], cwd=tree, capture_output=True, text=True, env=GIT_ENV)
            report["pushed"] = r.returncode == 0
        print(json.dumps(report, indent=1, ensure_ascii=False))
    finally:
        if os.path.exists(tree):
            git("worktree", "remove", "--force", tree, check=False)


def cmd_score(a):
    jd = read_jd(a.jd)
    weights = jd_weights(jd)
    main = show(a.branch, "resume.tex")
    body = main[main.index(r"\begin{document}"):].replace(r"\input{skills.tex}", show(a.branch, "skills.tex"))
    sc, present = score(plain(body), weights)
    print(json.dumps({"branch": a.branch, "score": sc,
                      "found": sorted(pretty(k) for k in present),
                      "missing": [pretty(k) for k in sorted(set(weights) - present, key=lambda k: -weights[k])]}, indent=1))


def cmd_track(a):
    jd = read_jd(a.jd)
    t, sc = pick_track(jd, jd_weights(jd))
    print(json.dumps({"track": t, "scores": sc}))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tailor"); t.add_argument("--jd", required=True); t.add_argument("--company", required=True)
    t.add_argument("--role", required=True); t.add_argument("--track", default="auto", choices=("auto",) + TRACKS)
    t.add_argument("--push", action="store_true", help="push the tailored branch to origin")
    t.add_argument("--dry-run", action="store_true")
    t.add_argument("--no-rewrite", action="store_true", help="keep Experience/Projects bullets as-is (Skills-only tailoring)")
    s = sub.add_parser("score"); s.add_argument("--jd", required=True); s.add_argument("--branch", default="main")
    k = sub.add_parser("track"); k.add_argument("--jd", required=True)
    a = p.parse_args()
    {"tailor": cmd_tailor, "score": cmd_score, "track": cmd_track}[a.cmd](a)
