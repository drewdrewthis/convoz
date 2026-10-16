#!/usr/bin/env python3
"""Render the e2e JSON report into one HTML page of use-proof (commands, HTTP calls, output and exit status per scenario).

Usage: proof_report.py <results.json> <out.html> | --self-test
Exit 1 if any transcript is empty (EMPTY) or looks like it leaks a credential (LEAK); no page is left then.
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
# Hex split by spaces, colons or one line break (fingerprints, xxd, openssl); counted after the separators go.
# A group is at most 32 hex chars: a longer line is not a split value (stacked 40-char git SHAs are not a key),
# and a 64-char line is HEX_RUN's. Two 32-char halves over a line break are still one value.
HEX_SPLIT = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{2,32}(?:[ :]+|[ :]*\r?\n[ :]*)(?:[0-9A-Fa-f]{2,32}(?:[ :]+|[ :]*\r?\n[ :]*))*[0-9A-Fa-f]{2,32}(?![0-9A-Fa-f])")
# go.sum digest: 32 bytes of sha256 as exactly 43 base64 chars plus one "=".
GO_SUM_DIGEST = re.compile(r"[A-Za-z0-9+/]{43}=")
# 43 chars is the shortest base64 of 32 bytes; both alphabets, optional padding.
B64_RUN = re.compile(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43,}={0,2}")
# WebAuthn ceremony fields are public protocol data (a one-time challenge, what the browser signed and sent back).
WEBAUTHN_FIELD = re.compile(r'"(?:challenge|clientDataJSON|attestationObject|authenticatorData|signature)"\s*:\s*"$')
# A fake Convoz token: its marker says so, and it is shown in full on purpose.
TEST_TOKEN = re.compile(r"cvz_[a-z]_TESTONLY[A-Za-z0-9]*")
PEM = re.compile(r"-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PUBLIC KEY)?-----")


FILLER = re.compile(r"(.)\1{15,}")


def is_filler(run):
    """Padding, not key material: one or two distinct characters, or a path (it has a "/") that is under
    43 characters once every stretch of 16 or more equal characters ("aaaa...") is taken out."""
    return len(set(run.lower())) <= 2 or ("/" in run and len(FILLER.sub("", run)) < 43)


def is_test_b64(run):
    """True when the run decodes to exactly 32 bytes that start with the TESTONLY marker."""
    body = run.rstrip("=").replace("-", "+").replace("_", "/")
    try:
        raw = base64.b64decode(body + "=" * (-len(body) % 4), validate=True)
        return len(raw) == 32 and raw.startswith(MARKER.encode())
    except ValueError:
        return False


def is_benign_b64(text, m):
    """Shapes that are long base64-alphabet runs but not secrets: go.sum `h1:` digests, lowercase paths,
    fake (TESTONLY) tokens and the public fields of a WebAuthn ceremony."""
    run = m.group(0)
    start = m.start()
    if text[max(0, start - 3):start] == "h1:" and (start < 4 or not text[start - 4].isalnum()):
        if GO_SUM_DIGEST.fullmatch(run):
            return True
    if is_filler(run):
        return True
    if HEX_RUN.fullmatch(run):
        return True  # hex is reported at 64+ only (HEX_RUN); shorter hex such as SHAs is not a key
    if TEST_TOKEN.fullmatch(run) or WEBAUTHN_FIELD.search(text[max(0, start - 40):start]):
        return True
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
            shots = [
                base64.b64encode(Path(a["path"]).read_bytes()).decode()
                for a in result.get("attachments", [])
                if a.get("contentType") == "image/png" and a.get("path") and Path(a["path"]).is_file()
            ]
            yield {
                "shots": shots,
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
        found += [(title, "hex", len(m.group(0))) for m in HEX_RUN.finditer(text) if not is_filler(m.group(0))]
        for m in HEX_SPLIT.finditer(text):
            digits = len(re.sub(r"[\s:]", "", m.group(0)))
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
        # The last screenshot is the final state of the page. Screenshots are pixels: the leak scan reads text only.
        shot = f"<img alt='final screenshot' style='max-width:100%;margin-top:8px' src='data:image/png;base64,{s['shots'][-1]}'>" if s.get("shots") else ""
        parts.append(
            f"<section><h2>{html.escape(s['title'])}</h2><div>{tags}<span class={cls}>{html.escape(s['status'])}</span>"
            f" &middot; {s['ms']} ms</div>{shot}<pre>{html.escape(s['transcript'])}</pre></section>"
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
            label = "EMPTY" if kind in ("empty transcript", "no scenarios") else "LEAK"
            print(f"{label} ({kind}, {length} chars) in '{title}'", file=sys.stderr)
        return 1
    out.write_text(render(scens, commit()))
    return 0


def self_test():
    """Plant each leak kind and assert the verdict; exit 0 only when every verdict is right."""
    key = bytes(range(32))
    plain_kek = base64.b64encode(key).decode()
    test_kek = base64.b64encode(MARKER.encode() + key[: 32 - len(MARKER)]).decode()
    mixed = base64.b64encode(bytes((i * 37 + 11) % 256 for i in range(32))).decode()  # has "/" and mixed case
    key33 = base64.b64encode(bytes(range(33))).decode()  # 44 chars, no "="
    long_test = base64.b64encode(MARKER.encode() + bytes(40)).decode()
    dump = "".join(f"{i:02x}:" for i in range(16)) + "\n" + ":".join(f"{i:02x}" for i in range(16, 32)) + "\n"
    hex16 = "0123456789abcdef"
    benign = (
        "go: github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db\n"
        "h1:" + plain_kek + "\ncommit 7cb8d65" + "0" * 33 + "\n"
    )
    cases = [
        ("base64 KEK, not TESTONLY", f"kek {plain_kek}\n", {"base64"}),
        ("base64 KEK, url-safe alphabet", f"kek {plain_kek.replace('+', '-').replace('/', '_')}\n", {"base64"}),
        ("TESTONLY KEK", f"kek {test_kek}\n", set()),
        ("base64 with slash and mixed case", f"kek {mixed}\n", {"base64"}),
        ("lowercase path with slashes", "see internal/server/platform/db/migrations/0001_init_schema_up\n", set()),
        ("h1: without padding", "h1:" + key33 + "\n", {"base64"}),
        ("xh1: digest", "xh1:" + plain_kek + "\n", {"base64"}),
        ("spaced h1: digest", " h1:" + plain_kek + "\n", set()),
        ("TESTONLY plus 40 bytes", f"kek {long_test}\n", {"base64"}),
        ("split hex across lines", dump, {"split hex"}),
        ("dashed token", "tok cvz_a_abc-def_ghi0123\n", {"token"}),
        ("TESTONLY token", "tok cvz_a_TESTONLY_abcd\n", set()),
        ("96 hex", hex16 * 6 + "\n", {"hex"}),
        ("filler: one character repeated", "path /tmp/" + "a" * 110 + ".sock\n", set()),
        ("a path with a filler segment", "stderr: path $TMP/convoz-s1a-RIOaag/" + "a" * 110 + ".sock\n", set()),
        ("a key that merely contains a filler stretch", "kek " + mixed[:20] + "A" * 16 + mixed[20:] + "\n", {"base64"}),
        ("split hex, spaces", " ".join([hex16] * 4) + "\n", {"split hex"}),
        ("split hex, colons", ":".join([hex16] * 4) + "\n", {"split hex"}),
        ("stacked 40-char git SHAs", "7cb8d65" + "0" * 33 + "\n" + "a1b2c3d" + "e" * 33 + "\n" + "0123456" + "f" * 33 + "\n", set()),
        ("64 hex split 32/32 over a line break", hex16 * 2 + "\n" + hex16 * 2 + "\n", {"split hex"}),
        ("WebAuthn challenge field", '{"publicKey":{"challenge":"' + plain_kek.rstrip("=").replace("+", "-").replace("/", "_") + '"}}\n', set()),
        ("the same bytes outside a WebAuthn field", 'kek ' + plain_kek.rstrip("=").replace("+", "-").replace("/", "_") + "\n", {"base64"}),
        ("TESTONLY token in a URL", "open https://convoz.testonly.ts.net/bootstrap#cvz_b_TESTONLY" + "aB3" * 14 + "\n", set()),
        ("long real-looking token", "tok cvz_b_" + "aB3" * 15 + "\n", {"token", "base64"}),
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
    with tempfile.TemporaryDirectory(prefix="proof-self-test-") as tmp:
        return self_test_leak_exit(Path(tmp), plain_kek)


def self_test_leak_exit(work, plain_kek):
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
    for p in problems:
        print(f"FAIL end-to-end: {p}", file=sys.stderr)
    return len(problems)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
