#!/usr/bin/env python3
"""Ratchet gate: eslint-suppressions.json may only shrink.

The file lists today's offences of the component-library rules (raw <button> and <input>, style props, .css imports in features,
files over 300 lines) as counted suppressions. A fix lowers a count (`eslint --prune-suppressions`); this check fails when a file
or a rule appears that the base does not have, or a count is higher than the base's.

The base is eslint-suppressions.json at `git merge-base HEAD origin/feat/web-react`; when there is no merge base, or the file does
not exist there yet (the commit that introduced it), it is the copy committed at HEAD. With neither, there is nothing to compare.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = "eslint-suppressions.json"
BASE_BRANCH = "origin/feat/web-react"


def git(*args):
    done = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else None


def committed(rev):
    text = git("show", f"{rev}:{NAME}")
    return json.loads(text) if text else None


def counts(suppressions):
    return {(path, rule): entry["count"] for path, rules in suppressions.items() for rule, entry in rules.items()}


def main():
    with open(os.path.join(ROOT, NAME)) as fh:
        now = counts(json.load(fh))
    merge_base = git("merge-base", "HEAD", BASE_BRANCH)
    base, where = (committed(merge_base), f"merge base {merge_base[:9]}") if merge_base else (None, "")
    if base is None:
        base, where = committed("HEAD"), "HEAD"
    if base is None:
        print(f"{NAME}: no base to compare with, nothing to check")
        return 0
    before = counts(base)
    rises = [f"{path}: {rule} {before.get((path, rule), 0)} -> {n}" for (path, rule), n in sorted(now.items()) if n > before.get((path, rule), 0)]
    for line in rises:
        print(f"{NAME} rose against {where}: {line}")
    return 1 if rises else 0


if __name__ == "__main__":
    sys.exit(main())
