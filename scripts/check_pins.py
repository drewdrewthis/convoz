#!/usr/bin/env python3
"""Supply-chain gate: the build uses only pinned inputs.

Checks (exit 1 on any failure, one line per problem):
  1. every `uses:` in .github/workflows is pinned to a 40-hex commit SHA;
  2. CI installs with `pnpm install --frozen-lockfile` and builds Go with -mod=readonly;
  3. `go mod verify` passes in apps/convoz;
  4. the SQLite module's go.sum line equals apps/convoz/sqlite-module.sum.
There is no Wasm file to hash: the engine ships inside the Go module, so its go.sum hash is the pin.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GO_DIR = os.path.join(ROOT, "apps", "convoz")
SQLITE_MODULE = "github.com/ncruces/go-sqlite3-wasm/v6"
USES_RE = re.compile(r"^\s*-?\s*uses:\s*(\S+)")


def check_actions(problems):
    wf_dir = os.path.join(ROOT, ".github", "workflows")
    texts = []
    for fn in sorted(os.listdir(wf_dir)) if os.path.isdir(wf_dir) else []:
        if not fn.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(wf_dir, fn), encoding="utf-8") as fh:
            text = fh.read()
        texts.append(text)
        for n, line in enumerate(text.splitlines(), 1):
            m = USES_RE.match(line)
            if m and not m.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
                problems.append(f".github/workflows/{fn}:{n}: action not pinned by 40-hex SHA: {m.group(1)}")
    joined = "\n".join(texts)
    if "--frozen-lockfile" not in joined:
        problems.append("workflows: pnpm install must use --frozen-lockfile")
    if "-mod=readonly" not in joined:
        problems.append("workflows: Go must build with -mod=readonly")


def check_go_verify(problems):
    go = shutil.which("go") or "/usr/local/go/bin/go"
    env = dict(os.environ, GOFLAGS="-mod=readonly")
    res = subprocess.run([go, "mod", "verify"], cwd=GO_DIR, env=env, capture_output=True, text=True, timeout=45)
    if res.returncode != 0:
        problems.append("go mod verify failed: " + (res.stdout + res.stderr).strip())


def check_sqlite_sum(problems):
    with open(os.path.join(GO_DIR, "go.sum"), encoding="utf-8") as fh:
        lines = [l.strip() for l in fh if l.startswith(SQLITE_MODULE + " ") and "/go.mod" not in l]
    with open(os.path.join(GO_DIR, "sqlite-module.sum"), encoding="utf-8") as fh:
        recorded = [l.strip() for l in fh if l.strip()]
    if not lines or lines != recorded:
        problems.append(f"SQLite module checksum differs: go.sum {lines} vs sqlite-module.sum {recorded}")


def main():
    problems = []
    check_actions(problems)
    check_go_verify(problems)
    check_sqlite_sum(problems)
    for p in problems:
        print(p)
    if not problems:
        print("pins ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
