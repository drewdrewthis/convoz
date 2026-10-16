#!/usr/bin/env python3
"""Render the e2e JSON report into one HTML page of use-proof (stdout and exit code per scenario).

Usage: proof_report.py <results.json> <out.html>
Exit 1 if any transcript looks like it leaks a credential; no page is written then.
"""
import base64
import html
import json
import re
import subprocess
import sys
from pathlib import Path

TOKEN = re.compile(r"cvz_[a-z]_[A-Za-z0-9]{16,}")
HEX64 = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])")
PEM = re.compile(r"-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PUBLIC KEY)?-----")


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
                if a["name"] == "cli-transcript" and "body" in a
            )
            yield {
                "title": spec["title"],
                "tags": spec.get("tags", []),
                "status": test["status"],
                "ms": result["duration"],
                "transcript": transcript,
            }


def leaks(scens):
    """Every credential-shaped string a transcript carries without the TESTONLY marker."""
    found = []
    for s in scens:
        text = s["transcript"]
        found += [(s["title"], "token", m.group(0)) for m in TOKEN.finditer(text) if "TESTONLY" not in m.group(0)]
        found += [(s["title"], "64-hex", m.group(0)) for m in HEX64.finditer(text)]
        found += [(s["title"], "PEM header", m.group(0)) for m in PEM.finditer(text)]
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
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    scens = list(scenarios(json.loads(Path(argv[1]).read_text())))
    bad = leaks(scens)
    if bad:
        for title, kind, value in bad:
            print(f"LEAK ({kind}) in '{title}': {value[:12]}...", file=sys.stderr)
        return 1
    Path(argv[2]).write_text(render(scens, commit()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
