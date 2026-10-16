#!/usr/bin/env python3
"""Parity gate: every Gherkin scenario is bound to one passing end-to-end test.

Usage: python3 -I parity.py <specs-dir> <tests-dir> <playwright-results.json>
       python3 -I parity.py --self-test

Rules (docs/testing.md §3, the S0 plan "Parity"):
  1. Every @v1 scenario that is not @unimplemented has exactly one binding, and the
     binding carries the same driver tag(s) (@browser/@cli/@mcp/@api) as the scenario.
  2. A binding that names no scenario fails.
  3. Every binding ran and ended with status == expectedStatus == "passed" in the
     Playwright JSON report, so a skip, an expected failure, test.fail() or a flaky
     retry is a failure. A bound test missing from the report did not run: a failure.
  4. A scenario that is bound and still tagged @unimplemented fails (stale tag).
     A scenario with neither @v1 nor @later fails, so a missing tag cannot hide it.
     A binding whose body has no `expect(` call asserts nothing and fails.
  5. One binding per Scenario Outline; its Examples rows run inside that one test.
  6. A @needs-owner scenario that is not @unimplemented is run by hand: it needs its runbook
     `docs/owner-checks/<slug>.md` (next to the specs dir; slug = the title in lowercase, runs of
     other characters as "-") and must have no binding. It is counted as "needs owner", never as passed.
  7. The counts of @unimplemented and needs-owner scenarios are always printed.
Bindings are read from the report (title and tags) and from the test sources
(`scenario("<title>", ...)`, double-quoted, so a test that never ran is still seen).
Output: one line per problem. Exit 1 if any problem, else 0.
"""
import importlib.util
import json
import os
import re
import sys
import tempfile

DRIVERS = {"@browser", "@cli", "@mcp", "@api"}


def runbook_slug(title):
    """File stem of a scenario's owner runbook."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
BIND_RE = re.compile(r'\bscenario\(\s*("(?:[^"\\]|\\.)*")')
EXPECT_RE = re.compile(r"\bexpect\s*\(")


def load_checker():
    # python -I drops the script directory from sys.path, so load the sibling by path.
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_specs.py")
    spec = importlib.util.spec_from_file_location("check_specs", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def code_only(text):
    """`text` with comments and the insides of string literals blanked, same length."""
    blank = lambda t: re.sub(r"[^\n]", " ", t)
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            out.append(blank(text[i:end]))
            i = end
        elif text.startswith("/*", i):
            end = text.find("*/", i)
            end = n if end < 0 else end + 2
            out.append(blank(text[i:end]))
            i = end
        elif c in "'\"`":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            out.append(c + blank(text[i + 1:j]) + c)
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def call_body(code, open_paren):
    """The text of the balanced (...) that starts at `open_paren` in comment-free code."""
    depth = 0
    for i in range(open_paren, len(code)):
        depth += {"(": 1, ")": -1}.get(code[i], 0)
        if depth == 0:
            return code[open_paren:i + 1]
    return code[open_paren:]


def source_bindings(tests_dir):
    """(title -> [files] for every scenario("...") call under tests_dir,
    title -> [files] for the calls whose body has no expect( call)."""
    found, no_expect = {}, {}
    for root, _, files in os.walk(tests_dir):
        for fn in sorted(files):
            if not fn.endswith((".ts", ".tsx", ".js", ".mjs")):
                continue
            path = os.path.join(root, fn)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            code = code_only(text)
            for m in BIND_RE.finditer(text):
                try:
                    title = json.loads(m.group(1))
                except ValueError:
                    continue
                found.setdefault(title, []).append(path)
                if not EXPECT_RE.search(call_body(code, text.index("(", m.start()))):
                    no_expect.setdefault(title, []).append(path)
    return found, no_expect


def report_bindings(report_path):
    """title -> [ {tags, expected, status, results, file} ] from Playwright's JSON report."""
    with open(report_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    out = {}

    def walk(suite):
        for sp in suite.get("specs", []):
            tags = {t if t.startswith("@") else "@" + t for t in sp.get("tags", [])}
            for t in sp.get("tests", []):
                tags |= {x if x.startswith("@") else "@" + x for x in t.get("tags", [])}
                out.setdefault(sp["title"], []).append({
                    "tags": tags,
                    "expected": t.get("expectedStatus"),
                    "status": t.get("status"),
                    "results": [r.get("status") for r in t.get("results", [])],
                    "file": sp.get("file", suite.get("file", "")),
                    "project": t.get("projectName", ""),
                })
        for s in suite.get("suites", []):
            walk(s)

    for s in doc.get("suites", []):
        walk(s)
    return out


def check(specs_dir, tests_dir, report_path):
    """Return (problems, unimplemented_count, bound_count, needs_owner_count)."""
    cs = load_checker()
    problems = []
    parse_errors = []
    scenarios, _ = cs.collect(specs_dir, parse_errors)
    problems += [f"spec parse error: {e}" for e in parse_errors]
    by_title = {}
    for sc in scenarios:
        by_title.setdefault(sc.name, sc)
    src, no_expect = source_bindings(tests_dir)
    rep = report_bindings(report_path)
    unimpl = 0
    bound = 0
    needs_owner = 0
    runbooks = os.path.join(os.path.dirname(os.path.abspath(specs_dir)), "docs", "owner-checks")

    for sc in scenarios:
        tags = set(sc.tags)
        where = f"{sc.ref}:{sc.line}"
        if "@later" in tags and "@v1" not in tags:
            continue
        if "@unimplemented" in tags:
            unimpl += 1
            if sc.name in rep or sc.name in src:
                problems.append(f"{where}: {sc.name!r} is bound but still tagged @unimplemented")
            continue
        if "@v1" not in tags:
            problems.append(f"{where}: {sc.name!r} has neither @v1 nor @later; tag it")
            continue
        if "@needs-owner" in tags:
            needs_owner += 1
            slug = runbook_slug(sc.name)
            if not os.path.isfile(os.path.join(runbooks, slug + ".md")):
                problems.append(f"{where}: {sc.name!r} is @needs-owner and needs the runbook docs/owner-checks/{slug}.md")
            if sc.name in rep or sc.name in src:
                problems.append(f"{where}: {sc.name!r} is @needs-owner: run by hand, so it must have no binding")
            continue
        # The "mobile" project (S-U0) runs every @browser scenario again as a phone. A @phone scenario runs only there, so its
        # mobile run is its binding; for the others the desktop run is, and the mobile run is checked by the proof report.
        phone = "@phone" in tags
        runs = [r for r in rep.get(sc.name, []) if (r.get("project") == "mobile") == phone]
        n = max(len(runs), len(src.get(sc.name, [])))
        if n == 0:
            problems.append(f"{where}: {sc.name!r} has no binding")
            continue
        if n > 1:
            problems.append(f"{where}: {sc.name!r} has {n} bindings, expected exactly one (one binding per outline)")
        bound += 1
        for f in no_expect.get(sc.name, []):
            problems.append(f"{f}: binding {sc.name!r} has no expect( call, so it asserts nothing")
        if not runs:
            problems.append(f"{where}: {sc.name!r} is bound but did not run (not in the report)")
            continue
        want = tags & DRIVERS
        for r in runs:
            got = r["tags"] & DRIVERS
            if want != got:
                problems.append(f"{where}: {sc.name!r} driver tags differ: scenario {sorted(want)}, binding {sorted(got)}")
            if r["expected"] != "passed":
                problems.append(f"{where}: {sc.name!r} expected status is {r['expected']!r} (test.fail or skip), must be 'passed'")
            elif r["status"] != "expected" or not r["results"] or r["results"][-1] != "passed":
                last = r["results"][-1] if r["results"] else "no result"
                problems.append(f"{where}: {sc.name!r} did not pass (status {r['status']!r}, last result {last!r})")

    for title in sorted(set(rep) | set(src)):
        if title not in by_title:
            files = ", ".join(sorted({r["file"] for r in rep.get(title, [])} | set(src.get(title, []))))
            problems.append(f"{files}: binding {title!r} names no scenario")
    return problems, unimpl, bound, needs_owner


FEATURE = """Feature: Demo
  @v1 @cli
  Scenario: Alpha
    When a
    Then b

  @v1 @cli
  Scenario: Beta
    When a
    Then b

  @v1 @api @unimplemented
  Scenario: Gamma
    When a
    Then b
"""

UNTAGGED = """Feature: Extra
  Scenario: Untagged
    When a
    Then b
"""


def _report(*specs):
    return {"suites": [{"file": "t.spec.ts", "specs": [
        {"title": t, "file": "t.spec.ts", "tags": tags, "tests": [
            {"expectedStatus": exp, "status": st, "results": [{"status": res}]}]}
        for t, tags, exp, st, res in specs]}]}


def self_test():
    ok = True

    def expect(label, cond):
        nonlocal ok
        print(f"self-test {'ok  ' if cond else 'FAIL'} {label}")
        ok = ok and cond

    with tempfile.TemporaryDirectory(prefix="parity-selftest-") as d:
        os.makedirs(os.path.join(d, "specs", "features"))
        os.makedirs(os.path.join(d, "specs", "contracts"))
        os.makedirs(os.path.join(d, "tests"))
        with open(os.path.join(d, "specs", "features", "demo.feature"), "w") as fh:
            fh.write(FEATURE)

        def run_case(sources, rep, body="expect(1).toBe(1);", extra="Feature: Extra\n"):
            with open(os.path.join(d, "specs", "features", "extra.feature"), "w") as fh:
                fh.write(extra)
            with open(os.path.join(d, "tests", "a.spec.ts"), "w") as fh:
                fh.write("\n".join(f'scenario({json.dumps(t)}, {{ tag: ["@cli"] }}, async () => {{ {body} }});' for t in sources))
            rp = os.path.join(d, "r.json")
            with open(rp, "w") as fh:
                json.dump(rep, fh)
            return check(os.path.join(d, "specs"), os.path.join(d, "tests"), rp)

        good = _report(("Alpha", ["@cli"], "passed", "expected", "passed"),
                       ("Beta", ["@cli"], "passed", "expected", "passed"))
        p, u, _, _ = run_case(["Alpha", "Beta"], good)
        expect("clean run has no problems", p == [])
        expect("counts @unimplemented", u == 1)

        p, _, _, _ = run_case(["Alpha", "Beta"], good, extra=UNTAGGED)
        expect("catches a scenario with neither @v1 nor @later", any("'Untagged' has neither @v1 nor @later" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], good, body="")
        expect("catches a binding with an empty body", any("binding 'Alpha' has no expect( call" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], good, body='// expect(1).toBe(1);\nconst s = "expect(1)";')
        expect("a commented or quoted expect( does not count", any("binding 'Beta' has no expect( call" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta", "Gamma"], _report(
            ("Alpha", ["@cli"], "passed", "expected", "passed"), ("Beta", ["@cli"], "passed", "expected", "passed"),
            ("Gamma", ["@api"], "passed", "expected", "passed")))
        expect("catches a stale @unimplemented tag", any("'Gamma' is bound but still tagged @unimplemented" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], _report(("Alpha", ["@cli"], "passed", "expected", "passed")))
        expect("catches a binding missing from the report", any("'Beta' is bound but did not run" in x for x in p))

        p, _, _, _ = run_case(["Alpha"], _report(("Alpha", ["@cli"], "passed", "expected", "passed")))
        expect("catches an unbound scenario", any("'Beta' has no binding" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta", "Nope"], _report(
            ("Alpha", ["@cli"], "passed", "expected", "passed"), ("Beta", ["@cli"], "passed", "expected", "passed"),
            ("Nope", ["@cli"], "passed", "expected", "passed")))
        expect("catches an unknown binding", any("'Nope' names no scenario" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], _report(
            ("Alpha", ["@cli"], "passed", "skipped", "skipped"), ("Beta", ["@cli"], "passed", "expected", "passed")))
        expect("catches a skipped test", any("'Alpha' did not pass" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], _report(
            ("Alpha", ["@cli"], "failed", "expected", "failed"), ("Beta", ["@cli"], "passed", "expected", "passed")))
        expect("catches an expected-fail test", any("'Alpha' expected status" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], _report(
            ("Alpha", ["@api"], "passed", "expected", "passed"), ("Beta", ["@cli"], "passed", "expected", "passed")))
        expect("catches a driver tag mismatch", any("driver tags differ" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta"], _report(
            ("Alpha", ["@cli"], "passed", "expected", "passed"), ("Beta", ["@cli"], "passed", "unexpected", "failed")))
        expect("catches a failing test", any("'Beta' did not pass" in x for x in p))

        p, _, _, _ = run_case(["Alpha", "Beta", "Alpha"], good)
        expect("catches a double binding", any("'Alpha' has 2 bindings" in x for x in p))

        owner_feature = "Feature: Phone\n  @v1 @browser @needs-owner\n  Scenario: On a real phone\n    When a\n    Then b\n"
        runbook = os.path.join(d, "docs", "owner-checks", "on-a-real-phone.md")
        p, _, _, n = run_case(["Alpha", "Beta"], good, extra=owner_feature)
        expect("a @needs-owner scenario without its runbook fails", any("needs the runbook docs/owner-checks/on-a-real-phone.md" in x for x in p))
        os.makedirs(os.path.dirname(runbook))
        with open(runbook, "w") as fh:
            fh.write("steps\n")
        p, _, _, n = run_case(["Alpha", "Beta"], good, extra=owner_feature)
        expect("a @needs-owner scenario with its runbook passes and is counted", p == [] and n == 1)
        p, _, _, _ = run_case(["Alpha", "Beta", "On a real phone"], _report(
            ("Alpha", ["@cli"], "passed", "expected", "passed"), ("Beta", ["@cli"], "passed", "expected", "passed"),
            ("On a real phone", ["@browser"], "passed", "expected", "passed")), extra=owner_feature)
        expect("a bound @needs-owner scenario fails", any("run by hand" in x for x in p))
    return 0 if ok else 1


def main(argv):
    if argv[1:] == ["--self-test"]:
        return self_test()
    if len(argv) != 4:
        print(__doc__)
        return 2
    specs_dir, tests_dir, report = argv[1:]
    if not os.path.exists(report):
        print(f"{report}: no Playwright JSON report (run the e2e suite first)")
        print("unimplemented scenarios: unknown")
        return 1
    problems, unimpl, bound, needs_owner = check(specs_dir, tests_dir, report)
    for p in problems:
        print(p)
    print(f"unimplemented scenarios: {unimpl}")
    print(f"needs owner (run by hand, not passed): {needs_owner}")
    print(f"bound scenarios: {bound}; problems: {len(problems)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
