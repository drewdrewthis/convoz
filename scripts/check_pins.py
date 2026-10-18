#!/usr/bin/env python3
"""Supply-chain gate: the build uses only pinned inputs.

Checks (exit 1 on any failure, one line per problem):
  1. every `uses:` in .github/workflows is pinned to a 40-hex commit SHA;
  2. CI installs with `pnpm install --frozen-lockfile` and builds Go with -mod=readonly;
  3. `go mod verify` passes in apps/convoz (the build's graph; the sqlc tool module, tools/sqlc, has its own CI step, because
     verify re-hashes every module of its graph and sqlc's graph alone cost twice what the build's does);
  4. the SQLite module's go.sum line equals apps/convoz/sqlite-module.sum;
  5. the WebAuthn library is required at the pinned version and go.sum has its checksum;
  6. Playwright is pinned to an exact version and CI installs its chromium;
  7. the confusables table (identity/confusables.tsv) was generated from the Unicode file that
     scripts/gen_confusables.py pins by SHA-256.
There is no Wasm file to hash: the engine ships inside the Go module, so its go.sum hash is the pin.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _go_bin():
    # python -I drops the script directory from sys.path, so load the sibling by path.
    spec = importlib.util.spec_from_file_location("gotool", os.path.join(HERE, "gotool.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.go_bin()

GO_DIR = os.path.join(ROOT, "apps", "convoz")
SQLITE_MODULE = "github.com/ncruces/go-sqlite3-wasm/v6"
WEBAUTHN_MODULE = "github.com/go-webauthn/webauthn"
WEBAUTHN_VERSION = "v0.18.2"  # the newest release at least 14 days old when S1a was built
USES_RE = re.compile(r"^\s*-?\s*uses:\s*(\S+)")
RUN_RE = re.compile(r"^(\s*)(?:-\s+)?run:\s*(.*)$")
GOFLAGS_RE = re.compile(r"^\s*GOFLAGS:\s*(.*)$")


def has_readonly_flag(text, command=True):
    """True when `-mod=readonly` is a whole flag token (not a substring of another word).
    A command line must also be a go invocation or set GOFLAGS; a GOFLAGS: value is already one."""
    tokens = re.split(r"[\s\"']+", text)
    if "-mod=readonly" not in [t.removeprefix("GOFLAGS=") for t in tokens]:
        return False
    return not command or "go" in tokens or any(t.startswith("GOFLAGS=") for t in tokens)


def run_commands(text):
    """Every `run:` command in a workflow, as (line, command). Comments are skipped,
    and a block scalar (`run: |`) yields one entry per line of its body."""
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        m = RUN_RE.match(lines[i]) if not lines[i].lstrip().startswith("#") else None
        i += 1
        if not m:
            continue
        indent, value = len(m.group(1)), m.group(2).split(" #")[0].strip()
        if value[:1] in ("|", ">"):
            while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > indent):
                if lines[i].strip() and not lines[i].lstrip().startswith("#"):
                    out.append((i + 1, lines[i].strip()))
                i += 1
        elif value:
            out.append((i, value))
    return out


def check_actions(problems):
    wf_dir = os.path.join(ROOT, ".github", "workflows")
    texts = []
    for fn in sorted(os.listdir(wf_dir)) if os.path.isdir(wf_dir) else []:
        if not fn.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(wf_dir, fn), encoding="utf-8") as fh:
            text = fh.read()
        texts.append((fn, text))
        for n, line in enumerate(text.splitlines(), 1):
            m = USES_RE.match(line)
            if m and not m.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
                problems.append(f".github/workflows/{fn}:{n}: action not pinned by 40-hex SHA: {m.group(1)}")
    installs, readonly = [], False
    for fn, text in texts:
        for n, cmd in run_commands(text):
            if re.search(r"\bpnpm\s+(install|i)\b", cmd):
                installs.append((fn, n, cmd))
            readonly = readonly or has_readonly_flag(cmd)
        for line in text.splitlines():
            m = GOFLAGS_RE.match(line)
            readonly = readonly or bool(m and has_readonly_flag(m.group(1).split(" #")[0], command=False))
    if not installs:
        problems.append("workflows: no `run:` line installs with pnpm")
    for fn, n, cmd in installs:
        if "--frozen-lockfile" not in cmd:
            problems.append(f".github/workflows/{fn}:{n}: pnpm install must use --frozen-lockfile: {cmd}")
    if not readonly:
        problems.append("workflows: Go must build with -mod=readonly (GOFLAGS or a run flag, not a comment)")


def check_go_verify(problems):
    go = _go_bin()
    env = dict(os.environ, GOFLAGS="-mod=readonly")
    res = subprocess.run([go, "mod", "verify"], cwd=GO_DIR, env=env, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        problems.append("go mod verify failed: " + (res.stdout + res.stderr).strip())


def check_sqlite_sum(problems):
    with open(os.path.join(GO_DIR, "go.sum"), encoding="utf-8") as fh:
        lines = [l.strip() for l in fh if l.startswith(SQLITE_MODULE + " ") and "/go.mod" not in l]
    with open(os.path.join(GO_DIR, "sqlite-module.sum"), encoding="utf-8") as fh:
        recorded = [l.strip() for l in fh if l.strip()]
    if not lines or lines != recorded:
        problems.append(f"SQLite module checksum differs: go.sum {lines} vs sqlite-module.sum {recorded}")


def check_webauthn_pin(problems):
    with open(os.path.join(GO_DIR, "go.mod"), encoding="utf-8") as fh:
        required = re.findall(rf"^\s*{re.escape(WEBAUTHN_MODULE)}\s+(\S+)", fh.read(), re.M)
    if required != [WEBAUTHN_VERSION]:
        problems.append(f"go.mod must require {WEBAUTHN_MODULE} {WEBAUTHN_VERSION}, found {required}")
    with open(os.path.join(GO_DIR, "go.sum"), encoding="utf-8") as fh:
        sums = [l for l in fh if l.startswith(f"{WEBAUTHN_MODULE} {WEBAUTHN_VERSION} h1:")]
    if not sums:
        problems.append(f"go.sum has no checksum for {WEBAUTHN_MODULE} {WEBAUTHN_VERSION}")


def check_playwright_pin(problems):
    with open(os.path.join(ROOT, "e2e", "package.json"), encoding="utf-8") as fh:
        version = json.load(fh).get("devDependencies", {}).get("@playwright/test", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        problems.append(f"e2e/package.json: @playwright/test must be an exact version, found {version!r}")
    wf = os.path.join(ROOT, ".github", "workflows", "ci.yml")
    with open(wf, encoding="utf-8") as fh:
        if not re.search(r"playwright install\b.*\bchromium\b", fh.read()):
            problems.append(".github/workflows/ci.yml: no step installs the pinned chromium (playwright install ... chromium)")


def check_confusables_pin(problems):
    spec = importlib.util.spec_from_file_location("gen_confusables", os.path.join(HERE, "gen_confusables.py"))
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    with open(gen.OUT, encoding="utf-8") as fh:
        header = fh.read(400)
    if f"# sha256: {gen.PINNED_SHA256}\n" not in header:
        problems.append("identity/confusables.tsv was not generated from the file pinned in scripts/gen_confusables.py")


def main():
    problems = []
    check_actions(problems)
    check_go_verify(problems)
    check_sqlite_sum(problems)
    check_webauthn_pin(problems)
    check_playwright_pin(problems)
    check_confusables_pin(problems)
    for p in problems:
        print(p)
    if not problems:
        print("pins ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
