#!/usr/bin/env python3
"""AC-1: a slice PR shows its scenarios red first and green at head.

Usage: python3 -I scripts/red_green.py <base> <head> [--runner PATH] [--scratch DIR]      (run inside the git repo)
       python3 -I scripts/red_green.py --self-test

  - The slice is every scenario bound at <head> (no @unimplemented, no @needs-owner) that was not bound at
    <base>: a new title, or a title that lost @unimplemented. @needs-owner scenarios are checked by hand.
  - The test-only commit is the first commit in <base>..<head> that touches only e2e/, specs/,
    docs/owner-checks/ and *_test.go files.
  - The runner is called as `PATH <checkout-dir> <title>...`, once with a checkout of the test-only commit
    and once with a checkout of <head>. It prints one JSON object {"<title>": "passed" | "failed"} on its last line and exits 0.
    The default runner builds the testhooks binary in the checkout and runs those titles with Playwright.
  - Every title must be "failed" on the test-only commit and "passed" at head.
  - Overlay: the same titles (as named at the test-only commit) must ALSO pass when the test-only commit's e2e/ and
    specs/ are laid over <head>'s production tree in a scratch checkout. So a later commit that weakens a test
    cannot turn red into green. Limit: a scenario already bound at <base> whose steps change is not in the slice
    and is not re-proven.
  - specs/red-green-exceptions.txt, only the lines this PR ADDED (diff merge-base(<base>,<head>)..<head>; an older line is
    ignored, so one PR's exception cannot excuse the next). One line each, blank lines and # comments ignored:
        <title at the test-only commit> | <reason>              skip that scenario in the overlay run
        <title at the test-only commit> | <title at head> | <reason>
                                                                 same, and red is taken from the old title, green from the new
    Every exception is printed in the log. An exception whose old title is absent at the test-only commit, whose
    new title is not in the slice, or (a skip line) whose title is not in the slice, is a FAIL.
  - --scratch DIR: parent for the checkouts (default: a fresh mkdtemp). Nothing in it is deleted.

Prints "test-only commit: <sha>", then "red: <title>" and "green: <title>" per title. A break prints
"FAIL: <title>: passed on the test-only commit" | "FAIL: <title>: failed at head" |
"FAIL: <title>: failed on the test-only tests over head's production" | "FAIL: no test-only commit" | "FAIL: exception ...".
A title is "failed" only if it ran and Playwright reported it unexpected. A build or install failure,
a crash, a missing report or a missing/skipped title prints "ERROR: ..." and exits 3 (never "red").
A "flaky" title (it failed, then passed on a retry) counts as an error too: only "expected" is green and only
"unexpected" is red, so a flake can neither prove a slice nor fail it.
Exit 0 when the slice is proven (or empty), 1 on any FAIL.
"""
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEST_ONLY_DIRS = ("e2e/", "specs/", "docs/owner-checks/")


def is_test_only_path(path):
    return path.startswith(TEST_ONLY_DIRS) or path.endswith("_test.go")


def is_bound(tags):
    return "@unimplemented" not in tags and "@needs-owner" not in tags


def newly_bound(before, after):
    """Titles bound in `after` that were absent or unbound in `before` (title -> (tags, ...) maps)."""
    return sorted({key[1] for key, fp in after.items()
                   if is_bound(fp[0]) and not (key in before and is_bound(before[key][0]))})


def load(path, name):
    # python -I drops the script directory from sys.path, so load siblings by path.
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(*args, binary=False):
    r = subprocess.run(["git", *args], capture_output=True, timeout=300)
    if r.returncode != 0:
        raise SystemExit("red_green: git " + " ".join(args) + " failed: " + r.stderr.decode("utf-8", "replace").strip())
    return r.stdout if binary else r.stdout.decode("utf-8")


def slice_titles(base, head):
    """Titles bound at head that were not bound at base."""
    sd = load(os.path.join(ROOT, "specs", "scripts", "spec_diff.py"), "spec_diff")
    cs = sd.load_checker()
    with tempfile.TemporaryDirectory(prefix="red-green-specs-") as tmp:
        before, after = sd.scenarios_at(base, cs, tmp), sd.scenarios_at(head, cs, tmp)
    return newly_bound(before, after)


def test_only_commit(base, head):
    """The first commit in base..head that touches only test paths, or None."""
    for sha in git("rev-list", "--reverse", "--no-merges", f"{base}..{head}").split():
        files = [f for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha).split("\n") if f]
        if files and all(is_test_only_path(f) for f in files):
            return sha
    return None


def extract(sha, dest, *pathspec):
    data = git("archive", "--format=tar", sha, *(("--", *pathspec) if pathspec else ()), binary=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        if hasattr(tarfile, "data_filter"):
            tf.extractall(dest, filter="data")
        else:
            tf.extractall(dest)


def checkout(sha, dest, tests_from=None):
    """Export the tree of `sha` into dest (no worktree, no change to this repo).
    With `tests_from`, e2e/ and specs/ come from that commit instead: its tests over `sha`'s production tree."""
    if tests_from is None:
        extract(sha, dest)
        return
    extract(sha, dest, ".", ":(exclude)e2e", ":(exclude)specs")
    extract(tests_from, dest, "e2e", "specs")


def default_runner(directory, titles):
    """Build the testhooks binary in `directory` and run `titles` with Playwright; title -> passed|failed."""
    gotool = load(os.path.join(HERE, "gotool.py"), "gotool")
    env = dict(os.environ, GOFLAGS="-mod=readonly")
    built = subprocess.run([gotool.go_bin(), "build", "-trimpath", "-tags", "testhooks", "-o", "bin/convoz-test", "./cmd/convoz"],
                           cwd=os.path.join(directory, "apps", "convoz"), env=env, capture_output=True, text=True, timeout=600)
    if built.returncode != 0:
        raise RunnerError("go build failed: " + built.stderr.strip()[-500:])
    pnpm = os.environ.get("PNPM_BIN", "pnpm")
    if subprocess.run([pnpm, "install", "--frozen-lockfile"], cwd=directory, capture_output=True, timeout=900).returncode != 0:
        raise RunnerError("pnpm install failed")
    grep = "|".join(re.escape(t) for t in titles)
    # The e2e config writes the JSON report to e2e/report/results.json. A red run exits non-zero, so the
    # exit code is not checked: the report decides.
    subprocess.run([pnpm, "--filter", "@convoz/e2e", "exec", "playwright", "test", "-g", grep],
                   cwd=directory, capture_output=True, timeout=1800)
    return results_from_report(os.path.join(directory, "e2e", "report", "results.json"), titles)


class RunnerError(Exception):
    """The run itself broke (build, install, crash, no report, missing title). That is never "red"."""


def results_from_report(path, titles):
    """title -> passed|failed from a Playwright JSON report. "failed" only if the test ran and was unexpected."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as err:
        raise RunnerError(f"no readable report at {path}: {err}")
    seen = {}

    def walk(suite):
        for sp in suite.get("specs", []):
            statuses = [t.get("status") for t in sp.get("tests", [])]
            if not statuses or any(s not in ("expected", "unexpected") for s in statuses):
                state = "unrun"
            else:
                state = "passed" if all(s == "expected" for s in statuses) else "failed"
            prev = seen.get(sp["title"])
            seen[sp["title"]] = state if prev in (None, state) else ("unrun" if "unrun" in (prev, state) else "failed")
        for s in suite.get("suites", []):
            walk(s)

    for s in doc.get("suites", []):
        walk(s)
    return check_complete({t: seen.get(t, "missing") for t in titles})


def check_complete(res):
    bad = {t: v for t, v in res.items() if v not in ("passed", "failed")}
    if bad:
        raise RunnerError("not run: " + "; ".join(f"{t} ({v})" for t, v in bad.items()))
    return res


def parse_runner_output(res, titles):
    """A custom runner prints one JSON object on its last line; anything else is a runner failure."""
    if res.returncode != 0:
        raise RunnerError(f"runner exited {res.returncode}")
    try:
        out = json.loads(res.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        raise RunnerError("runner printed no JSON")
    if not isinstance(out, dict):
        raise RunnerError("runner JSON is not an object")
    return check_complete({t: out.get(t, "missing") for t in titles})


def run_at(sha, titles, runner, scratch, tests_from=None):
    tmp = tempfile.mkdtemp(prefix="red-green-", dir=scratch)
    checkout(sha, tmp, tests_from)
    if runner is None:
        return default_runner(tmp, titles)
    res = subprocess.run([runner, tmp, *titles], cwd=tmp, capture_output=True, text=True, timeout=3600)
    return parse_runner_output(res, titles)


EXCEPTIONS_PATH = "specs/red-green-exceptions.txt"


def parse_exceptions(text):
    """[(old_title, new_title | None, reason)] from the exceptions file; ValueError on a malformed line."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) == 2:
            parts = [parts[0], None, parts[1]]
        if len(parts) != 3 or not parts[0] or not parts[2] or parts[1] == "":
            raise ValueError(f"{EXCEPTIONS_PATH}:{n}: want 'title | reason' or 'old | new | reason'")
        out.append(tuple(parts))
    return out


def added_lines(diff_text):
    """The text of the lines a unified diff adds (no file headers)."""
    return "\n".join(ln[1:] for ln in diff_text.splitlines() if ln.startswith("+") and not ln.startswith("+++"))


def prove(titles, exceptions, titles_at_first, run_red, run_green, run_overlay):
    """(exit code, log lines). run_* take titles and return title -> passed|failed, or raise RunnerError."""
    out, bad = [], False
    for old, new, reason in exceptions:
        out.append(f"exception: {old}" + (f" -> {new}" if new else "") + f" | {reason}")
        if old not in titles_at_first:
            out.append(f"FAIL: exception names a title absent at the test-only commit: {old}")
            bad = True
        if new is None and old not in titles:
            out.append(f"FAIL: exception skips a title that is not in the slice: {old}")
            bad = True
        if new is not None and new not in titles:
            out.append(f"FAIL: exception renames to a title that is not in the slice: {new}")
            bad = True
    if bad:
        return 1, out
    red_name = {new: old for old, new, _ in exceptions if new}
    skipped = {old for old, _, _ in exceptions}
    try:
        red = run_red([red_name.get(t, t) for t in titles])
        green = run_green(titles)
        overlay_titles = [red_name.get(t, t) for t in titles if red_name.get(t, t) not in skipped]
        overlay = run_overlay(overlay_titles) if overlay_titles else {}
    except RunnerError as err:
        out.append(f"ERROR: {err}")
        return 3, out
    for t in titles:
        old = red_name.get(t, t)
        if red.get(old) != "failed":
            out.append(f"FAIL: {t}: passed on the test-only commit")
            bad = True
        elif green.get(t) != "passed":
            out.append(f"FAIL: {t}: failed at head")
            bad = True
        elif old not in skipped and overlay.get(old) != "passed":
            out.append(f"FAIL: {t}: failed on the test-only tests over head's production")
            bad = True
        else:
            out += [f"red: {old}", f"green: {t}"] + ([] if old in skipped else [f"overlay: {old}"])
    return (1 if bad else 0), out


def self_test():
    """Crash, missing report and missing title are errors; only a real failure is red."""
    import types
    failures = []

    def expect_error(label, fn):
        try:
            fn()
        except RunnerError:
            return
        failures.append(label)

    def runner_out(stdout, code=0):
        return types.SimpleNamespace(stdout=stdout, returncode=code)

    expect_error("no JSON", lambda: parse_runner_output(runner_out("boom\n"), ["a"]))
    expect_error("empty output", lambda: parse_runner_output(runner_out(""), ["a"]))
    expect_error("runner crash", lambda: parse_runner_output(runner_out('{"a": "failed"}', 1), ["a"]))
    expect_error("title missing", lambda: parse_runner_output(runner_out('{"b": "failed"}'), ["a"]))
    if parse_runner_output(runner_out('{"a": "failed"}'), ["a"]) != {"a": "failed"}:
        failures.append("real failure is red")
    with tempfile.TemporaryDirectory(prefix="red-green-self-test-") as tmp:
        report = os.path.join(tmp, "results.json")
        expect_error("missing report", lambda: results_from_report(report, ["a"]))
        with open(report, "w", encoding="utf-8") as fh:
            json.dump({"suites": [{"specs": [
                {"title": "a", "tests": [{"status": "unexpected"}]},
                {"title": "b", "tests": [{"status": "expected"}]},
                {"title": "c", "tests": [{"status": "skipped"}]}]}]}, fh)
        if results_from_report(report, ["a", "b"]) != {"a": "failed", "b": "passed"}:
            failures.append("report: unexpected is red, expected is green")
        expect_error("skipped title", lambda: results_from_report(report, ["c"]))
        expect_error("absent title", lambda: results_from_report(report, ["zzz"]))
    def fp(*tags):
        return (tuple(tags), None, (), ())

    before = {("f", "kept"): fp("@unimplemented"), ("f", "lost"): fp("@unimplemented"), ("f", "bound"): fp(),
              ("f", "owner"): fp("@unimplemented")}
    after = {("f", "kept"): fp("@unimplemented"), ("f", "lost"): fp(), ("f", "bound"): fp(), ("f", "new"): fp(),
             ("f", "new-unimpl"): fp("@unimplemented"), ("f", "new-owner"): fp("@needs-owner"), ("f", "owner"): fp("@needs-owner")}
    if newly_bound(before, after) != ["lost", "new"]:
        failures.append("slice = new titles and lost @unimplemented only")
    for path, ok in (("e2e/tests/a.spec.ts", True), ("specs/features/a.feature", True), ("docs/owner-checks/a.md", True),
                     ("apps/x/auth_test.go", True), ("apps/x/auth.go", False), ("docs/design.md", False)):
        if is_test_only_path(path) != ok:
            failures.append("test-only path " + path)
    def fake(result):
        return lambda ts: {t: result.get(t, "passed") for t in ts}

    failed = fake({"a": "failed"})
    code, log = prove(["a"], [], {"a"}, failed, fake({}), fake({}))
    if code != 0 or "overlay: a" not in log:
        failures.append("red, green and overlay pass")
    code, log = prove(["a"], [], {"a"}, failed, fake({}), fake({"a": "failed"}))
    if code != 1 or not any(l.startswith("FAIL: a: failed on the test-only tests") for l in log):
        failures.append("weakened after the test commit fails")
    seen = []
    code, log = prove(["a"], [("a", None, "why")], {"a"}, failed, fake({}), lambda ts: seen.append(ts) or {})
    if code != 0 or "exception: a | why" not in log or seen:
        failures.append("listed exception passes, is logged and is not run in the overlay")
    code, log = prove(["a"], [("zzz", None, "why")], {"a"}, failed, fake({}), fake({}))
    if code != 1 or not any("absent at the test-only commit" in l for l in log):
        failures.append("unknown exception fails")
    code, log = prove(["new"], [("old", "new", "why")], {"old"}, fake({"old": "failed"}), fake({}), fake({}))
    if code != 0 or "red: old" not in log or "green: new" not in log:
        failures.append("rename: red from the old title, green from the new")
    code, _ = prove(["new"], [("old", "other", "why")], {"old"}, failed, fake({}), fake({}))
    if code != 1:
        failures.append("rename to a title outside the slice fails")
    code, log = prove(["b"], [("a", None, "why")], {"a", "b"}, fake({"a": "failed", "b": "failed"}), fake({}), fake({}))
    if code != 1 or not any("not in the slice: a" in l for l in log):
        failures.append("a skip line for a title outside the slice fails")
    old_line = "-gone | old\n+++ b/specs/red-green-exceptions.txt\n"
    diff = "--- a/specs/red-green-exceptions.txt\n+++ b/specs/red-green-exceptions.txt\n@@ -1,2 +1,3 @@\n kept | old line\n+new | added line\n"
    if parse_exceptions(added_lines(diff)) != [("new", None, "added line")]:
        failures.append("an old line that this PR did not add is ignored, an added line is applied")
    if added_lines(old_line) != "":
        failures.append("diff headers and removed lines are not exceptions")
    if parse_exceptions("# c\n\nA | r\nB | C | r2\n") != [("A", None, "r"), ("B", "C", "r2")]:
        failures.append("parse exceptions")
    for bad_line in ("only title", "A | | r", "A | B | C | D"):
        try:
            parse_exceptions(bad_line)
            failures.append("malformed exception line: " + bad_line)
        except ValueError:
            pass
    for f in failures:
        print("FAIL:", f, file=sys.stderr)
    print("self-test failed" if failures else "self-test ok", file=sys.stderr if failures else sys.stdout)
    return 1 if failures else 0


def main(argv):
    runner = scratch = None
    args = argv[1:]
    if args == ["--self-test"]:
        return self_test()
    if "--runner" in args:
        i = args.index("--runner")
        runner = os.path.abspath(args[i + 1])
        args = args[:i] + args[i + 2:]
    if "--scratch" in args:
        i = args.index("--scratch")
        scratch = os.path.abspath(args[i + 1])
        args = args[:i] + args[i + 2:]
    if len(args) != 2:
        print(__doc__)
        return 2
    scratch = scratch or tempfile.mkdtemp(prefix="red-green-scratch-")
    base, head = args
    titles = slice_titles(base, head)
    if not titles:
        print("no scenario is newly bound (new title or lost @unimplemented): nothing to prove")
        return 0
    first = test_only_commit(base, head)
    if first is None:
        print("FAIL: no test-only commit")
        return 1
    print(f"test-only commit: {first}")
    head_sha = git("rev-parse", head).strip()
    try:
        merge_base = git("merge-base", base, head_sha).strip()
        exceptions = parse_exceptions(added_lines(git("diff", "--unified=0", merge_base, head_sha, "--", EXCEPTIONS_PATH)))
    except ValueError as err:
        print(f"FAIL: {err}")
        return 1
    sd = load(os.path.join(ROOT, "specs", "scripts", "spec_diff.py"), "spec_diff")
    with tempfile.TemporaryDirectory(prefix="red-green-specs-") as tmp:
        titles_at_first = {key[1] for key in sd.scenarios_at(first, sd.load_checker(), tmp)}
    code, log = prove(
        titles, exceptions, titles_at_first,
        lambda ts: run_at(first, ts, runner, scratch),
        lambda ts: run_at(head_sha, ts, runner, scratch),
        lambda ts: run_at(head_sha, ts, runner, scratch, tests_from=first))
    print("\n".join(log))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
