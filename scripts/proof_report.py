#!/usr/bin/env python3
"""Render the e2e JSON report into one HTML page of use-proof (stdout and exit code per scenario).

Usage: proof_report.py <results.json> <out.html> | --self-test
Exit 1 if any transcript is empty or looks like it leaks a credential; no page is left then.
"""
import base64
import contextlib
import html
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MARKER = "TESTONLY"
TOKEN = re.compile(r"cvz_[a-z]_[A-Za-z0-9_-]{8,}")
HEX_RUN = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{64,}(?![0-9A-Fa-f])")
# Hex split by single spaces or colons (fingerprints, hexdumps); counted after the separators go.
HEX_SPLIT = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{2,}(?:[ :][0-9A-Fa-f]{2,})+(?![0-9A-Fa-f])")
# 43 chars is the shortest base64 of 32 bytes; both alphabets, optional padding.
B64_RUN = re.compile(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43,}={0,2}")
PEM = re.compile(r"-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PUBLIC KEY)?-----")


def is_test_b64(run):
    """True when the run decodes to bytes that start with the TESTONLY marker."""
    body = run.rstrip("=").replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(body + "=" * (-len(body) % 4), validate=True).startswith(MARKER.encode())
    except ValueError:
        return False


def is_benign_b64(text, m):
    """Shapes that are long base64-alphabet runs but not secrets: go.sum `h1:` digests, lowercase paths."""
    run = m.group(0)
    if text[max(0, m.start() - 3):m.start()] == "h1:":
        return True
    if HEX_RUN.fullmatch(run):
        return True  # already reported as hex
    return "/" in run and run == run.lower()


def specs(suite):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from specs(child)


def scenarios(report):
    for suite in report["suites"]:
        for spec in specs(suite):
            test = spec["tests"][0]
            result = test["results"][-1]
            transcript = "".join(
                base64.b64decode(a["body"]).decode("utf-8", "replace")
                for a in result.get("attachments", [])
                if a["name"] == "transcript" and "body" in a
            )
            yield {
                "title": spec["title"],
                "tags": spec.get("tags", []),
                "status": test["status"],
                "ms": result["duration"],
                "transcript": transcript,
            }


def leaks(scens):
    """(title, kind, length) for every credential-shaped string a transcript carries, and for empty transcripts.

    Never returns the value itself: the report goes to CI logs.
    """
    found = []
    for s in scens:
        text = s["transcript"]
        title = s["title"]
        if not text.strip():
            found.append((title, "empty transcript", 0))
        found += [(title, "token", len(m.group(0))) for m in TOKEN.finditer(text) if MARKER not in m.group(0)]
        found += [(title, "hex", len(m.group(0))) for m in HEX_RUN.finditer(text)]
        for m in HEX_SPLIT.finditer(text):
            digits = len(re.sub("[ :]", "", m.group(0)))
            if digits >= 64:
                found.append((title, "split hex", digits))
        found += [
            (title, "base64", len(m.group(0)))
            for m in B64_RUN.finditer(text)
            if not is_benign_b64(text, m) and not is_test_b64(m.group(0))
        ]
        found += [(title, "PEM header", len(m.group(0))) for m in PEM.finditer(text)]
    return found


def commit():
    out = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=20)
    return out.stdout.strip() if out.returncode == 0 else "unknown"


CSS = """
body{background:#0d1117;color:#c9d1d9;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:24px;max-width:1000px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:0 0 6px;color:#e6edf3}
.meta{color:#8b949e;margin-bottom:20px}section{border:1px solid #30363d;border-radius:6px;padding:12px 14px;margin:0 0 16px}
.tag{background:#21262d;border-radius:3px;padding:1px 6px;margin-right:6px;color:#8b949e}
.ok{color:#3fb950}.bad{color:#f85149}
pre{background:#010409;border-radius:4px;padding:10px;margin:8px 0 0;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
"""


def render(scens, rev):
    parts = [f"<!doctype html><meta charset=utf-8><title>Convoz proof</title><style>{CSS}</style>",
             f"<h1>Convoz use-proof</h1><div class=meta>commit {html.escape(rev)} &middot; {len(scens)} scenarios &middot; leak scan clean</div>"]
    for s in scens:
        cls = "ok" if s["status"] == "expected" else "bad"
        tags = "".join(f"<span class=tag>@{html.escape(t.lstrip('@'))}</span>" for t in s["tags"])
        parts.append(
            f"<section><h2>{html.escape(s['title'])}</h2><div>{tags}<span class={cls}>{html.escape(s['status'])}</span>"
            f" &middot; {s['ms']} ms</div><pre>{html.escape(s['transcript'])}</pre></section>"
        )
    return "\n".join(parts)


def main(argv):
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    out = Path(argv[2])
    out.unlink(missing_ok=True)  # a failed scan must leave no page behind
    scens = list(scenarios(json.loads(Path(argv[1]).read_text())))
    bad = leaks(scens) if scens else [("(report)", "no scenarios", 0)]
    if bad:
        for title, kind, length in bad:
            print(f"LEAK ({kind}, {length} chars) in '{title}'", file=sys.stderr)
        return 1
    out.write_text(render(scens, commit()))
    return 0


def self_test():
    """Plant each leak kind and assert the verdict; exit 0 only when every verdict is right."""
    key = bytes(range(32))
    plain_kek = base64.b64encode(key).decode()
    test_kek = base64.b64encode(MARKER.encode() + key[: 32 - len(MARKER)]).decode()
    hex16 = "0123456789abcdef"
    benign = (
        "go: github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db\n"
        "h1:" + plain_kek + "\ncommit 7cb8d65" + "0" * 33 + "\n"
    )
    cases = [
        ("base64 KEK, not TESTONLY", f"kek {plain_kek}\n", {"base64"}),
        ("base64 KEK, url-safe alphabet", f"kek {plain_kek.replace('+', '-').replace('/', '_')}\n", {"base64"}),
        ("TESTONLY KEK", f"kek {test_kek}\n", set()),
        ("dashed token", "tok cvz_a_abc-def_ghi0123\n", {"token"}),
        ("TESTONLY token", "tok cvz_a_TESTONLY_abcd\n", set()),
        ("96 hex", hex16 * 6 + "\n", {"hex"}),
        ("split hex, spaces", " ".join([hex16] * 4) + "\n", {"split hex"}),
        ("split hex, colons", ":".join([hex16] * 4) + "\n", {"split hex"}),
        ("PEM", "-----BEGIN PRIVATE KEY-----\n", {"PEM header"}),
        ("empty transcript", "\n", {"empty transcript"}),
        ("benign output", benign, set()),
    ]
    failed = 0
    for title, text, want in cases:
        got = {kind for _, kind, _ in leaks([{"title": title, "transcript": text}])}
        if got != want:
            failed += 1
            print(f"FAIL {title}: want {sorted(want)}, got {sorted(got)}", file=sys.stderr)
    failed += self_test_run(plain_kek)
    print("self-test failed" if failed else "self-test ok", file=sys.stderr if failed else sys.stdout)
    return 1 if failed else 0


def self_test_run(plain_kek):
    """End to end through main(): a leak exits 1, prints no value and removes a stale page."""
    work = Path(tempfile.mkdtemp(prefix="proof-self-test-"))
    results, page = work / "results.json", work / "proof.html"
    body = base64.b64encode(f"kek {plain_kek}\n".encode()).decode()
    report = {"suites": [{"specs": [{"title": "t", "tags": [], "tests": [{"status": "expected", "results": [
        {"duration": 1, "attachments": [{"name": "transcript", "body": body}]}]}]}]}]}
    results.write_text(json.dumps(report))
    page.write_text("stale")
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = main(["proof_report.py", str(results), str(page)])
    problems = []
    if code != 1:
        problems.append(f"leaking report exited {code}, want 1")
    if page.exists():
        problems.append("stale proof.html survived a failed scan")
    if plain_kek[:8] in err.getvalue():
        problems.append("a leaked value was printed")
    for f in (results, page):
        f.unlink(missing_ok=True)
    work.rmdir()
    for p in problems:
        print(f"FAIL end-to-end: {p}", file=sys.stderr)
    return len(problems)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
