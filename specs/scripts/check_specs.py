#!/usr/bin/env python3
"""Parse-check and lint the Convoz Gherkin specs, then build the coverage matrix.

Layout (design draft 9 §4.4, docs/testing.md):
  specs/features/*.feature   user-facing scenarios: what Drew or an agent sees and does
  specs/contracts/*.feature  protocol, security and invariant scenarios (status codes,
                             headers, races, data-file checks); they pin implementation details

Why this exists: @cucumber/gherkin was not available offline when the specs were
written, so this is a small, strict parser for the Gherkin subset the specs use
(Feature, Rule, Background, Scenario, Scenario Outline, Examples, steps, tables,
doc strings, tags, comments). It also enforces the tag rules and the split: a
user-facing scenario may not name routes, status codes, headers, data-file scans,
database details or benchmarks, and may not carry @invariant.

Usage: python3 -I check_specs.py <specs-dir> [--write-coverage]
Exit 0 = clean. Exit 1 = errors (printed one per line as dir/file:line: message).
"""
import os
import re
import sys

STEP_KW = ("Given ", "When ", "Then ", "And ", "But ", "* ")
VERSION_TAGS = {"@v1", "@later"}
DRIVER_TAGS = {"@browser", "@cli", "@mcp", "@api"}
BANNED_TAGS = {"@unit", "@integration", "@e2e"}
TAG_RE = re.compile(r"^@[A-Za-z0-9_-]+$")
# (prefix in tag, count, label) -- the order is the order of the coverage sections
TRACKS = [
    ("I-", 51, "Invariants I-1…I-51 (design draft 9 §8)"),
    ("AC-", 29, "ACs AC-1…AC-29 (design draft 9 §19)"),
    ("AC-M", 15, "Message and app ACs AC-M1…AC-M15 (docs/messages-apps-spec.md §10)"),
    ("M", 8, "DA must-fixes M1…M8 on draft 8 (applied in draft 9)"),
    ("C-", 10, "Contradiction picks C-1…C-10 (design draft 9 §17)"),
]
TRACK_RE = {
    "I-": re.compile(r"^@I-(\d+)$"),
    "AC-": re.compile(r"^@AC-(\d+)$"),
    "AC-M": re.compile(r"^@AC-M(\d+)$"),
    "M": re.compile(r"^@M(\d+)$"),
    "C-": re.compile(r"^@C-(\d+)$"),
}
# Things a user-facing scenario must not say. Say it in the user's words, or move it to contracts/.
USER_BANNED = [
    (re.compile(r"\b(GET|POST|PATCH|PUT|DELETE|HEAD) /"), "an HTTP route"),
    (re.compile(r"\bthe server answers\b|\banswers? [1-5]\d\d\b|\b[1-5]\d\d with the code\b"), "an HTTP status"),
    (re.compile(r"\bheaders?\b|Cache-Control|Content-Security-Policy|\bCSP\b|X-Convoz|Clear-Site-Data|Last-Event-ID|Retry-After"), "a header"),
    (re.compile(r"\bdata file\b|\bbyte scan\b|\bWAL\b"), "a data-file check"),
    (re.compile(r"\btrigger\b|\bSQL\b|\bCHECK constraint\b"), "a database detail"),
    (re.compile(r"\bp95\b|\bBenchmark"), "a benchmark"),
]
KINDS = ("features", "contracts")


class Scn:
    def __init__(self, path, line, kind, name, tags, rule, where):
        self.path, self.line, self.kind, self.name = path, line, kind, name
        self.tags, self.rule, self.where = tags, rule, where
        self.steps = []          # (line, keyword, text)
        self.examples = []       # list of [header, rows]

    @property
    def ref(self):
        return f"{self.where}/{os.path.basename(self.path)}"


def parse(path, where, errors):
    rel = f"{where}/{os.path.basename(path)}"
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    def err(n, msg):
        errors.append(f"{rel}:{n}: {msg}")

    feature_seen = False
    feature_name = ""
    pending_tags = []
    scenarios = []
    cur = None
    bg_steps = 0
    rule = None
    table_width = None
    in_doc = None
    section = "pre"
    for i, raw in enumerate(lines, 1):
        s = raw.strip()
        if in_doc:
            if s == in_doc:
                in_doc = None
            continue
        if not s or s.startswith("#"):
            table_width = None if not s else table_width
            continue
        if s.startswith('"""') or s.startswith("```"):
            if section not in ("scenario", "background") or not (cur and (cur == "background" or cur.steps)):
                err(i, "doc string outside a step")
            in_doc = s[:3]
            continue
        if s.startswith("|"):
            if not s.endswith("|"):
                err(i, "table row must end with |")
            cells = [c.strip() for c in s[1:-1].split("|")]
            if table_width is None:
                table_width = len(cells)
            elif len(cells) != table_width:
                err(i, f"table row has {len(cells)} cells, expected {table_width}")
            if section == "examples":
                ex = cur.examples[-1]
                if ex[0] is None:
                    ex[0] = cells
                else:
                    ex[1].append(cells)
            elif section in ("scenario", "background"):
                if cur != "background" and not cur.steps:
                    err(i, "table before any step")
            else:
                err(i, "table outside a step or Examples")
            continue
        table_width = None
        if s.startswith("@"):
            for t in s.split():
                if t.startswith("#"):
                    break
                if not TAG_RE.match(t):
                    err(i, f"bad tag {t!r}")
                pending_tags.append(t)
            continue
        m = re.match(r"^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):\s*(.*)$", s)
        if m:
            kw, name = m.group(1), m.group(2).strip()
            if kw == "Feature":
                if feature_seen:
                    err(i, "second Feature in one file")
                feature_seen = True
                feature_name = name
                section = "feature"
                pending_tags = []
            elif not feature_seen:
                err(i, f"{kw} before Feature")
            elif kw == "Rule":
                if pending_tags:
                    err(i, "tags on Rule are not used in these specs")
                    pending_tags = []
                if not name:
                    err(i, "Rule without a name")
                if isinstance(cur, Scn):
                    finish(cur, err)  # the last scenario of the previous Rule was never linted
                rule = name
                section = "feature"
                cur = None
            elif kw == "Background":
                if pending_tags:
                    err(i, "tags on Background")
                    pending_tags = []
                if any(sc.rule == rule for sc in scenarios):
                    err(i, "Background after a scenario in the same scope")
                cur = "background"
                bg_steps = 0
                section = "background"
            elif kw in ("Scenario", "Example", "Scenario Outline", "Scenario Template"):
                if isinstance(cur, Scn):
                    finish(cur, err)
                if cur == "background" and bg_steps == 0:
                    err(i, "Background with no steps")
                if not name:
                    err(i, "scenario without a name")
                outline = kw in ("Scenario Outline", "Scenario Template")
                cur = Scn(path, i, "outline" if outline else "scenario", name, pending_tags, rule, where)
                pending_tags = []
                scenarios.append(cur)
                section = "scenario"
            else:
                if not isinstance(cur, Scn):
                    err(i, "Examples outside a scenario")
                    continue
                if cur.kind != "outline":
                    err(i, "Examples under a plain Scenario (use Scenario Outline)")
                pending_tags = []
                cur.examples.append([None, []])
                section = "examples"
            continue
        if s.startswith(STEP_KW):
            kw = s.split(" ", 1)[0]
            text = s[len(kw):].strip()
            if section == "background":
                if bg_steps == 0 and kw in ("And", "But"):
                    err(i, "Background starts with And/But")
                bg_steps += 1
            elif section == "scenario":
                if not cur.steps and kw in ("And", "But"):
                    err(i, f"scenario starts with {kw}")
                cur.steps.append((i, kw, text))
            elif section == "examples":
                err(i, "step after Examples")
            else:
                err(i, "step outside a scenario")
            continue
        if section == "feature":
            continue
        if section == "scenario" and not cur.steps:
            continue
        if section == "background" and bg_steps == 0:
            continue
        err(i, f"unexpected text: {s[:60]!r}")
    if in_doc:
        err(len(lines), "unclosed doc string")
    if isinstance(cur, Scn):
        finish(cur, err)
    if not feature_seen:
        err(1, "no Feature")
    if where == "contracts" and not feature_name.endswith("(contracts)"):
        err(1, "a contracts file's Feature name ends with '(contracts)'")
    if where == "features" and feature_name.endswith("(contracts)"):
        err(1, "a user-facing Feature name must not end with '(contracts)'")
    if where == "features":
        for sc in scenarios:
            lint_user(sc, err)
    return scenarios


def lint_user(sc, err):
    if "@invariant" in sc.tags:
        err(sc.line, f"user-facing scenario {sc.name!r} carries @invariant: move it to specs/contracts")
    texts = [(sc.line, sc.name)] + [(n, t) for n, _, t in sc.steps]
    for hdr, rows in sc.examples:
        texts += [(sc.line, " ".join(r)) for r in rows]
    for n, t in texts:
        for rx, what in USER_BANNED:
            if rx.search(t):
                err(n, f"user-facing scenario {sc.name!r} names {what}: say it in the user's words or move it to specs/contracts")
                break


def finish(sc, err):
    if not sc.steps:
        err(sc.line, f"scenario {sc.name!r} has no steps")
    kws = [k for _, k, _ in sc.steps]
    if "Then" not in kws and "*" not in kws:
        err(sc.line, f"scenario {sc.name!r} has no Then")
    if sc.kind == "outline":
        if not sc.examples:
            err(sc.line, f"outline {sc.name!r} has no Examples")
        for hdr, rows in sc.examples:
            if hdr is None or not rows:
                err(sc.line, f"outline {sc.name!r} has an Examples table without rows")
                continue
            used = set(re.findall(r"<([^<>]+)>", " ".join(t for _, _, t in sc.steps) + " " + sc.name))
            missing = used - set(hdr)
            if missing:
                err(sc.line, f"outline {sc.name!r} uses {sorted(missing)} not in Examples")
    tags = set(sc.tags)
    v = tags & VERSION_TAGS
    if len(v) != 1:
        err(sc.line, f"scenario {sc.name!r} needs exactly one of @v1/@later, has {sorted(v)}")
    if not tags & DRIVER_TAGS:
        err(sc.line, f"scenario {sc.name!r} needs a driver tag (@browser/@cli/@mcp/@api)")
    if tags & BANNED_TAGS:
        err(sc.line, f"scenario {sc.name!r} uses a dropped tag {sorted(tags & BANNED_TAGS)}")
    if "@phone" in tags and "@browser" not in tags:
        err(sc.line, f"scenario {sc.name!r}: @phone needs @browser")
    for t in tags:
        for prefix, top, _ in TRACKS:
            mm = TRACK_RE[prefix].match(t)
            if mm and not 1 <= int(mm.group(1)) <= top:
                err(sc.line, f"tag {t} out of range ({prefix}1…{prefix}{top})")


def collect(root, errors):
    all_sc, per_file = [], []
    for where in KINDS:
        d = os.path.join(root, where)
        if not os.path.isdir(d):
            errors.append(f"{where}/: missing directory")
            continue
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".feature"):
                sc = parse(os.path.join(d, fn), where, errors)
                per_file.append((where, fn, sc))
                all_sc.extend(sc)
    return all_sc, per_file


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    errors = []
    all_sc, per_file = collect(root, errors)
    seen = {}
    for sc in all_sc:
        key = sc.name.lower()
        if key in seen:
            errors.append(f"{sc.ref}:{sc.line}: duplicate scenario name {sc.name!r} (first at {seen[key]})")
        else:
            seen[key] = f"{sc.ref}:{sc.line}"
    for e in errors:
        print(e)
    for where, fn, sc in per_file:
        v1 = sum(1 for x in sc if "@v1" in x.tags)
        later = sum(1 for x in sc if "@later" in x.tags)
        print(f"{where + '/' + fn:40s} {len(sc):4d} scenarios ({v1} v1, {later} later)")
    for where in KINDS:
        n = [x for x in all_sc if x.where == where]
        print(f"{'TOTAL ' + where:40s} {len(n):4d} ({sum(1 for x in n if '@v1' in x.tags)} v1)")
    print(f"{'TOTAL':40s} {len(all_sc):4d}")
    if "--write-coverage" in sys.argv:
        write_coverage(root, all_sc, per_file)
    return 1 if errors else 0


def write_coverage(root, all_sc, per_file):
    def ref(sc):
        mark = "" if sc.where == "features" else "contracts/"
        later = " *(later)*" if "@later" in sc.tags else ""
        return f"`{mark}{os.path.basename(sc.path)[:-8]}` · {sc.name}{later}"

    sections, gap_lines = [], []
    for prefix, n, label in TRACKS:
        rows, gaps, later_only = [], [], []
        for k in range(1, n + 1):
            tag = f"@{prefix}{k}"
            hits = [sc for sc in all_sc if tag in sc.tags]
            if not hits:
                gaps.append(f"{prefix}{k}")
            elif all("@later" in sc.tags for sc in hits):
                later_only.append(f"{prefix}{k}")
            users = sum(1 for sc in hits if sc.where == "features")
            v1 = sum(1 for sc in hits if "@v1" in sc.tags)
            cell = "<br>".join(ref(sc) for sc in hits) or "**GAP**"
            rows.append(f"| {prefix}{k} | {users} | {len(hits) - users} | {v1} | {cell} |")
        sections += [f"## {label}", "", "| Id | User-facing | Contract | v1 | Where |", "|---|---|---|---|---|", *rows, ""]
        gap_lines.append(f"- {label.split(' (')[0]}: no scenario: {', '.join(gaps) or 'none'}; "
                         f"only `@later`: {', '.join(later_only) or 'none'}.")
    users = [x for x in all_sc if x.where == "features"]
    contracts = [x for x in all_sc if x.where == "contracts"]
    count_rows = []
    names = sorted({fn for _, fn, _ in per_file})
    for fn in names:
        u = next((sc for w, f, sc in per_file if w == "features" and f == fn), [])
        c = next((sc for w, f, sc in per_file if w == "contracts" and f == fn), [])
        count_rows.append(f"| {fn[:-8]} | {len(u)} | {len(c)} | {sum(1 for x in u + c if '@v1' in x.tags)} | {sum(1 for x in u + c if '@later' in x.tags)} |")
    v1u = sum(1 for x in users if "@v1" in x.tags)
    v1c = sum(1 for x in contracts if "@v1" in x.tags)
    out = [
        "# Coverage: invariants, ACs and amendments against scenarios",
        "",
        "Generated by `specs/scripts/check_specs.py specs --write-coverage` from the scenario tags. Do not edit by hand.",
        "",
        "## Counts",
        "",
        f"- User-facing scenarios (`specs/features/`): **{len(users)}** ({v1u} v1, {len(users) - v1u} later).",
        f"- Contract scenarios (`specs/contracts/`): **{len(contracts)}** ({v1c} v1, {len(contracts) - v1c} later).",
        f"- Total: **{len(all_sc)}**. A Scenario Outline counts once, however many Examples rows it has.",
        "",
        "| Feature | User-facing | Contract | v1 | later |",
        "|---|---|---|---|---|",
        *count_rows,
        "",
        "## Gaps",
        "",
        *gap_lines,
        "",
        "GAPS_NOTES",
        "",
        *sections,
    ]
    notes_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coverage-notes.md")
    notes = open(notes_path, encoding="utf-8").read().strip() if os.path.exists(notes_path) else ""
    text = "\n".join(out).replace("GAPS_NOTES", notes)
    with open(os.path.join(root, "coverage.md"), "w", encoding="utf-8") as fh:
        fh.write(text.rstrip("\n") + "\n")


if __name__ == "__main__":
    sys.exit(main())
