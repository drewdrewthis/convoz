#!/usr/bin/env python3
"""AC-1: a slice PR shows its scenarios red first and green at head.

Usage: python3 -I scripts/red_green.py <base> <head> [--runner PATH]      (run inside the git repo)
       python3 -I scripts/red_green.py --self-test

  - The slice is the set of scenario titles that lose @unimplemented between <base> and <head>
    (@needs-owner scenarios are checked by hand and left out).
  - The test-only commit is the first commit in <base>..<head> that touches only e2e/ and specs/.
  - The runner is called as `PATH <checkout-dir> <title>...`, once with a checkout of the test-only commit
    and once with a checkout of <head>. It prints one JSON object {"<title>": "passed" | "failed"} on its last line and exits 0.
    The default runner builds the testhooks binary in the checkout and runs those titles with Playwright.
  - Every title must be "failed" on the test-only commit and "passed" at head.

Prints "test-only commit: <sha>", then "red: <title>" and "green: <title>" per title. A break prints
"FAIL: <title>: passed on the test-only commit" | "FAIL: <title>: failed at head" | "FAIL: no test-only commit".
A title is "failed" only if it ran and Playwright reported it unexpected. A build or install failure,
a crash, a missing report or a missing/skipped title prints "ERROR: ..." and exits 3 (never "red").
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
TEST_ONLY_DIRS = ("e2e/", "specs/")


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
    """Titles whose @unimplemented tag is gone at head."""
    sd = load(os.path.join(ROOT, "specs", "scripts", "spec_diff.py"), "spec_diff")
    cs = sd.load_checker()
    with tempfile.TemporaryDirectory(prefix="red-green-specs-") as tmp:
        before, after = sd.scenarios_at(base, cs, tmp), sd.scenarios_at(head, cs, tmp)
    titles = []
    for key, fp in after.items():
        old = before.get(key)
        if old and "@unimplemented" in old[0] and "@unimplemented" not in fp[0] and "@needs-owner" not in fp[0]:
            titles.append(key[1])
    return sorted(titles)


def test_only_commit(base, head):
    """The first commit in base..head that touches only e2e/ and specs/, or None."""
    for sha in git("rev-list", "--reverse", "--no-merges", f"{base}..{head}").split():
        files = [f for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha).split("\n") if f]
        if files and all(f.startswith(TEST_ONLY_DIRS) for f in files):
            return sha
    return None


def checkout(sha, dest):
    """Export the tree of `sha` into dest (no worktree, no change to this repo)."""
    data = git("archive", "--format=tar", sha, binary=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        if hasattr(tarfile, "data_filter"):
            tf.extractall(dest, filter="data")
        else:
            tf.extractall(dest)


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


def run_at(sha, titles, runner):
    with tempfile.TemporaryDirectory(prefix="red-green-") as tmp:
        checkout(sha, tmp)
        if runner is None:
            return default_runner(tmp, titles)
        res = subprocess.run([runner, tmp, *titles], cwd=tmp, capture_output=True, text=True, timeout=3600)
        return parse_runner_output(res, titles)


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
    for f in failures:
        print("FAIL:", f, file=sys.stderr)
    print("self-test failed" if failures else "self-test ok", file=sys.stderr if failures else sys.stdout)
    return 1 if failures else 0


def main(argv):
    runner = None
    args = argv[1:]
    if args == ["--self-test"]:
        return self_test()
    if "--runner" in args:
        i = args.index("--runner")
        runner = os.path.abspath(args[i + 1])
        args = args[:i] + args[i + 2:]
    if len(args) != 2:
        print(__doc__)
        return 2
    base, head = args
    titles = slice_titles(base, head)
    if not titles:
        print("no scenario loses @unimplemented: nothing to prove")
        return 0
    first = test_only_commit(base, head)
    if first is None:
        print("FAIL: no test-only commit")
        return 1
    print(f"test-only commit: {first}")
    try:
        red = run_at(first, titles, runner)
        head_sha = git("rev-parse", head).strip()
        green = run_at(head_sha, titles, runner)
    except RunnerError as err:
        print(f"ERROR: {err}")
        return 3
    failed = False
    for t in titles:
        if red.get(t) != "failed":
            print(f"FAIL: {t}: passed on the test-only commit")
            failed = True
        elif green.get(t) != "passed":
            print(f"FAIL: {t}: failed at head")
            failed = True
        else:
            print(f"red: {t}")
            print(f"green: {t}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
