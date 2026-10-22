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
    rises, moves = settle(counts(base), now)
    for path, rule, frm in moves:
        print(f"{NAME}: {path}: {rule} moved from deleted {frm}, not a rise against {where}")
    for line in rises:
        print(f"{NAME} rose against {where}: {line}")
    return 1 if rises else 0


def settle(before, now):
    """Return (rises, moves). A count may rise only by what files deleted since the base released for the same rule, each spent once."""
    released = {}
    for (path, rule), n in sorted(before.items()):
        if (path, rule) not in now:
            released.setdefault(rule, []).append([path, n])
    rises, moves = [], []
    for (path, rule), n in sorted(now.items()):
        base_n = before.get((path, rule), 0)
        need = n - base_n
        if need <= 0:
            continue
        pool = released.get(rule, [])
        for source in pool:
            if need <= 0:
                break
            spend = min(need, source[1])
            if spend:
                source[1] -= spend
                need -= spend
                moves.append((path, rule, source[0]))
        if need > 0:
            rises.append(f"{path}: {rule} {base_n} -> {n}")
    return rises, moves


def self_test():
    """Two cases: a count moved from a deleted file is allowed, a count with no released source is still a rise."""
    rises, moves = settle({("old.tsx", "r"): 2}, {("new.tsx", "r"): 2})
    assert rises == [] and moves == [("new.tsx", "r", "old.tsx")], (rises, moves)
    rises, moves = settle({("keep.tsx", "r"): 1}, {("keep.tsx", "r"): 2})
    assert rises == ["keep.tsx: r 1 -> 2"] and moves == [], (rises, moves)
    print("check_suppressions self-test: ok")
    return 0


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else main())
