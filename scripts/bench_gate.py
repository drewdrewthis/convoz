#!/usr/bin/env python3
"""Benchmark gate (quality-gates AC-9): a slice is NOT READY when a benchmark is over its p95 budget or 20 percent (or more) slower than main.

Usage: python3 -I scripts/bench_gate.py <new-results.txt> [--base <main-results.txt>] [--budgets <budgets.json>]

Both result files are `go test -bench` output, the text format benchstat reads. Each benchmark reports its p95 as the custom
metric `p95-ms` (b.ReportMetric(p, "p95-ms")). A benchmark run several times (-count) is judged by the median of its runs, as
benchstat does. benchstat itself is not vendored (the build has no network), so the median and the ratio are computed here.

A budgeted benchmark with no result is NOT READY too: a bench that did not run has not met its budget.
Prints one line per problem, then READY or NOT READY. Exit 1 when NOT READY, else 0.
"""
import json
import os
import re
import statistics
import sys

METRIC = "p95-ms"
REGRESSION = 1.20  # 20 percent slower than main, or more, blocks
LINE = re.compile(r"^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+(.*)$")


def read_results(path):
    """{benchmark: median p95 in ms} of a `go test -bench` output file."""
    runs = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = LINE.match(line.strip())
            if not m:
                continue
            fields = m.group(2).split()
            for value, unit in zip(fields, fields[1:]):
                if unit == METRIC:
                    runs.setdefault(m.group(1), []).append(float(value))
    return {name: statistics.median(vals) for name, vals in runs.items()}


def judge(new, base, budgets):
    """The problems of a result set: over budget, missing, or more than 20 percent slower than the base."""
    problems = []
    for name, budget in sorted(budgets.items()):
        if name not in new:
            problems.append(f"{name}: no result, so it has not met its budget of {budget:g} ms")
        elif new[name] > budget:
            problems.append(f"{name}: over budget, p95 {new[name]:.2f} ms is more than {budget:g} ms")
    for name, now in sorted(new.items()):
        was = base.get(name)
        if was and now >= was * REGRESSION - 1e-9:
            problems.append(f"{name}: regression, p95 {now:.2f} ms is {100 * (now / was - 1):.1f} percent slower than main ({was:.2f} ms)")
    return problems


def main(argv):
    args = argv[1:]
    opts = {"--base": None, "--budgets": os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench_budgets.json")}
    files = []
    while args:
        a = args.pop(0)
        if a in opts and args:
            opts[a] = args.pop(0)
        else:
            files.append(a)
    if len(files) != 1:
        print(__doc__)
        return 2
    with open(opts["--budgets"], encoding="utf-8") as f:
        budgets = {k: v for k, v in json.load(f).items() if k.startswith("Benchmark")}
    new = read_results(files[0])
    base = read_results(opts["--base"]) if opts["--base"] else {}
    problems = judge(new, base, budgets)
    for name in sorted(new):
        was = f" (main {base[name]:.2f} ms)" if name in base else ""
        print(f"{name}: p95 {new[name]:.2f} ms{was}")
    for p in problems:
        print(p)
    print("NOT READY" if problems else "READY")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
