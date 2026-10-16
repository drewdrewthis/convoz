#!/usr/bin/env python3
"""Go boundary check "go-imports" (design §4.3, AC-16, Go side).

Usage: python3 -I scripts/check_go_imports.py
Reads the packages with `go list -json` (with and without -tags testhooks, so build-tagged files count), then
fails, one line per break as "<file>:<line>: <why>", when
  1. a file in internal/cli or internal/mcp imports internal/server/...;
  2. a file in a server module imports another server module (allowed: platform, crypto, authz, its own
     subpackages; httpapi and testroutes are composition roots and may import any module);
  3. time.Now, time.Since, time.Until or time.Sleep appears in internal/server outside platform/clock.go
     (tests excepted): code takes a platform.Clock, so tests can move time.
Exit 0 when clean, 1 on a break, 2 when the packages cannot be listed.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GO_DIR = os.path.join(ROOT, "apps", "convoz")
SERVER = "internal/server"
SHARED = {"platform", "crypto", "authz"}
ROOTS = {"httpapi", "testroutes"}
CLOCK_FILE = "internal/server/platform/clock.go"
TIME_CALL = re.compile(r"\btime\.(Now|Since|Until|Sleep)\b")


def go_bin():
    # python -I drops the script directory from sys.path, so load the sibling by path.
    spec = importlib.util.spec_from_file_location("gotool", os.path.join(ROOT, "scripts", "gotool.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.go_bin()


def module_path():
    with open(os.path.join(GO_DIR, "go.mod"), encoding="utf-8") as fh:
        return re.search(r"^module\s+(\S+)", fh.read(), re.M).group(1)


def list_files():
    """Absolute paths of every Go file of the module under either tag set."""
    files = set()
    for tags in ([], ["-tags", "testhooks"]):
        res = subprocess.run([go_bin(), "list", "-e", "-json", *tags, "./..."], cwd=GO_DIR, capture_output=True, text=True,
                             timeout=120, env=dict(os.environ, GOFLAGS="-mod=readonly"))
        if res.returncode != 0:
            raise SystemExit("go-imports: go list failed: " + res.stderr.strip())
        dec, text, i = json.JSONDecoder(), res.stdout, 0
        while i < len(text):
            while i < len(text) and text[i].isspace():
                i += 1
            if i >= len(text):
                break
            pkg, i = dec.raw_decode(text, i)
            for key in ("GoFiles", "CgoFiles", "TestGoFiles", "XTestGoFiles", "IgnoredGoFiles"):
                files.update(os.path.join(pkg["Dir"], f) for f in pkg.get(key) or [])
    return sorted(f for f in files if f.endswith(".go"))


def code_only(text):
    """`text` with comments and string literals blanked (same length, newlines kept)."""
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
        elif c in "\"`'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" and c != "`" else 1
            out.append(c + blank(text[i + 1:j]) + c)
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


IMPORT_LINE = re.compile(r'^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"')


def imports(text):
    """(line number, import path) for each import of a Go file."""
    found, in_block = [], False
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if in_block:
            if stripped.startswith(")"):
                in_block = False
                continue
            m = IMPORT_LINE.match(line)
            if m:
                found.append((n, m.group(1)))
        elif re.match(r"import\s*\(", stripped):
            in_block = True
        elif stripped.startswith("import "):
            m = IMPORT_LINE.match(line)
            if m:
                found.append((n, m.group(1)))
        elif re.match(r"(func|type|var|const)\b", stripped):
            break  # imports end at the first declaration
    return found


def check(files, mod):
    problems = []
    server_prefix = f"{mod}/{SERVER}/"
    for path in files:
        rel = os.path.relpath(path, GO_DIR).replace(os.sep, "/")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        is_test = rel.endswith("_test.go")
        owner = None
        if rel.startswith(SERVER + "/"):
            owner = rel[len(SERVER) + 1:].split("/")[0]
        for line, imp in imports(text):
            if rel.startswith(("internal/cli/", "internal/mcp/")) and imp.startswith(f"{mod}/{SERVER}"):
                problems.append(f"{rel}:{line}: internal/cli and internal/mcp must not import internal/server ({imp})")
            if owner and owner not in ROOTS and imp.startswith(server_prefix):
                target = imp[len(server_prefix):].split("/")[0]
                if target != owner and target not in SHARED:
                    problems.append(f"{rel}:{line}: module {owner} must not import module {target} (use a port the caller declares)")
        if owner and not is_test and rel != CLOCK_FILE:
            code = code_only(text)
            for m in TIME_CALL.finditer(code):
                line = code.count("\n", 0, m.start()) + 1
                problems.append(f"{rel}:{line}: time.{m.group(1)} in server code (take a platform.Clock)")
    return problems


def main():
    problems = check(list_files(), module_path())
    for p in problems:
        print(p)
    print("go-imports: " + (f"{len(problems)} problem(s)" if problems else "ok"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
