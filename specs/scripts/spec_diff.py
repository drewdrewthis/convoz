#!/usr/bin/env python3
"""List the scenarios a PR adds, changes and removes, by file and title.

Usage: python3 -I spec_diff.py <base-ref> <head-ref>      (run inside the git repo)

Output, one line per scenario: `added|changed|removed <features|contracts>/<file>.feature: <title>`.
Printed to stdout and appended to $GITHUB_STEP_SUMMARY when it is set. It informs the
owner and never blocks: it always exits 0 (docs/testing.md §10). A scenario counts as
changed when its tags, steps or Examples differ.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

KINDS = ("features", "contracts")


def load_checker():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_specs.py")
    spec = importlib.util.spec_from_file_location("check_specs", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git {' '.join(args)} failed")
    return r.stdout


def scenarios_at(ref, cs, tmp):
    """(where/file, title) -> fingerprint of every scenario in specs/ at `ref`."""
    out = {}
    names = git("ls-tree", "-r", "--name-only", ref, "--", "specs").split("\n")
    for name in names:
        parts = name.split("/")
        if len(parts) != 3 or parts[1] not in KINDS or not parts[2].endswith(".feature"):
            continue
        where, fn = parts[1], parts[2]
        local = os.path.join(tmp, ref.replace("/", "_"), where)
        os.makedirs(local, exist_ok=True)
        path = os.path.join(local, fn)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(git("show", f"{ref}:{name}"))
        for sc in cs.parse(path, where, []):
            out[(f"{where}/{fn}", sc.name)] = (
                tuple(sorted(sc.tags)), sc.rule,
                tuple((k, t) for _, k, t in sc.steps),
                tuple((tuple(h or ()), tuple(map(tuple, rows))) for h, rows in sc.examples),
            )
    return out


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 0
    base, head = argv[1:]
    lines = []
    try:
        cs = load_checker()
        with tempfile.TemporaryDirectory(prefix="spec-diff-") as tmp:
            a, b = scenarios_at(base, cs, tmp), scenarios_at(head, cs, tmp)
        for key in sorted(set(a) | set(b)):
            if key not in a:
                lines.append(("added", key))
            elif key not in b:
                lines.append(("removed", key))
            elif a[key] != b[key]:
                lines.append(("changed", key))
    except Exception as e:  # never block the PR
        print(f"spec_diff: could not diff {base}..{head}: {e}")
        return 0
    text = [f"{k} {f}: {t}" for k, (f, t) in lines]
    n = {k: sum(1 for x, _ in lines if x == k) for k in ("added", "changed", "removed")}
    head_line = f"Scenario changes: {n['added']} added, {n['changed']} changed, {n['removed']} removed"
    print(head_line)
    for t in text:
        print(t)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("### " + head_line + "\n\n" + "".join(f"- {t}\n" for t in text) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
