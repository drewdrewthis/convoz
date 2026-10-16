#!/usr/bin/env python3
"""AC-1: a slice PR shows its scenarios red first and green at head.

Usage: python3 -I scripts/red_green.py <base> <head> [--runner PATH]      (run inside the git repo)

  - The slice is the set of scenario titles that lose @unimplemented between <base> and <head>
    (@needs-owner scenarios are checked by hand and left out).
  - The test-only commit is the first commit in <base>..<head> that touches only e2e/ and specs/.
  - The runner is called as `PATH <checkout-dir> <title>...`, once with a checkout of the test-only commit
    and once with a checkout of <head>. It prints one JSON object {"<title>": "passed" | "failed"}.
    The default runner builds the testhooks binary in the checkout and runs those titles with Playwright.
  - Every title must be "failed" on the test-only commit and "passed" at head.

Prints "test-only commit: <sha>", then "red: <title>" and "green: <title>" per title. A break prints
"FAIL: <title>: passed on the test-only commit" | "FAIL: <title>: failed at head" | "FAIL: no test-only commit".
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
        return {t: "failed" for t in titles}
    pnpm = os.environ.get("PNPM_BIN", "pnpm")
    for cmd in ([pnpm, "install", "--frozen-lockfile"],):
        if subprocess.run(cmd, cwd=directory, capture_output=True, timeout=900).returncode != 0:
            return {t: "failed" for t in titles}
    grep = "|".join(re.escape(t) for t in titles)
    # The e2e config writes the JSON report to e2e/report/results.json.
    subprocess.run([pnpm, "--filter", "@convoz/e2e", "exec", "playwright", "test", "-g", grep],
                   cwd=directory, capture_output=True, timeout=1800)
    return results_from_report(os.path.join(directory, "e2e", "report", "results.json"), titles)


def results_from_report(path, titles):
    out = {t: "failed" for t in titles}
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return out
    seen = {}

    def walk(suite):
        for sp in suite.get("specs", []):
            ok = all(t.get("status") == "expected" for t in sp.get("tests", [])) and bool(sp.get("tests"))
            seen[sp["title"]] = seen.get(sp["title"], True) and ok
        for s in suite.get("suites", []):
            walk(s)

    for s in doc.get("suites", []):
        walk(s)
    for t in titles:
        if seen.get(t):
            out[t] = "passed"
    return out


def run_at(sha, titles, runner):
    with tempfile.TemporaryDirectory(prefix="red-green-") as tmp:
        checkout(sha, tmp)
        if runner is None:
            return default_runner(tmp, titles)
        res = subprocess.run([runner, tmp, *titles], cwd=tmp, capture_output=True, text=True, timeout=3600)
        try:
            return json.loads(res.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            return {t: "failed" for t in titles}


def main(argv):
    runner = None
    args = argv[1:]
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
    red = run_at(first, titles, runner)
    head_sha = git("rev-parse", head).strip()
    green = run_at(head_sha, titles, runner)
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
