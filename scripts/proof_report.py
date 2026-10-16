#!/usr/bin/env python3
"""Render the e2e JSON report into one HTML page of use-proof (commands, HTTP calls, output and exit status per scenario).

Usage: proof_report.py <results.json> <out.html> | --self-test
Exit 1 if any transcript is empty (EMPTY) or looks like it leaks a credential (LEAK); no page is left then.
"""
import base64
import contextlib
import hashlib
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
# Groups have no upper length: a 64-char value wrapped 40+24 or 33+31 is still one value. The one shape
# that is skipped is a stack of lines that each hold nothing but one 40-hex SHA, see is_sha_stack.
HEX_SPLIT = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{2,}(?:[ :]+|[ :]*\r?\n[ :]*)(?:[0-9A-Fa-f]{2,}(?:[ :]+|[ :]*\r?\n[ :]*))*[0-9A-Fa-f]{2,}(?![0-9A-Fa-f])")
HEX_GROUP = re.compile(r"[0-9A-Fa-f]+")
# go.sum digest: 32 bytes of sha256 as exactly 43 base64 chars plus one "=".
GO_SUM_DIGEST = re.compile(r"[A-Za-z0-9+/]{43}=")
# 43 chars is the shortest base64 of 32 bytes; both alphabets, optional padding.
B64_RUN = re.compile(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43,}={0,2}")
# WebAuthn ceremony fields are public protocol data (a one-time challenge, what the browser signed and sent back).
# Each field has a ceiling on its base64url length, so a longer secret that follows the field name is still found.
WEBAUTHN_FIELD = re.compile(r'"(challenge|clientDataJSON|attestationObject|authenticatorData|signature)"\s*:\s*"$')
WEBAUTHN_MAX = {"challenge": 64, "signature": 100, "authenticatorData": 256, "clientDataJSON": 512, "attestationObject": 2048}
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
    if TEST_TOKEN.fullmatch(run):
        return True
    field = WEBAUTHN_FIELD.search(text[max(0, start - 40):start])
    if field and len(run.rstrip("=")) <= WEBAUTHN_MAX[field.group(1)]:
        return True
    return "/" in run and run == run.lower()


# The recorded command lines that take revisions as arguments: git, and the repo's own red/green checker (base and
# head SHAs). An allowlist, not a denylist of shell separators: the line must be the command and plain words, so no
# metacharacter ($ ` ( ) < > ; | & quotes, braces) can chain or expand into a command that
# prints one 80-hex value. The one `$` allowed is the literal $TMP/ the transcript writer puts in for a scratch path.
REVISION_LINE = re.compile(r"\$ (?:git [a-z][a-z-]*|python3 -I \./scripts/red_green\.py)(?: (?:[\w@%+=:,./^~-]+|\$TMP/[\w./-]+))*")
LONE_SHA = re.compile(r"[0-9A-Fa-f]{40}")
HEX_ANY = re.compile(r"[0-9A-Fa-f]+")
# Short hex runs (under 8) are ordinary words ("feat", "cafe"); a whole line of them must still stay far under 64 digits.
SHORT_HEX_BUDGET = 32


def is_sha_stack(text, m):
    """Git SHAs, not one long value. Either every line the match touches is one 40-hex token and nothing else
    (stacked lines), or the match sits on a recorded revision command line (REVISION_LINE) where every hex run of 8+
    digits anywhere in any word is exactly a 40-hex SHA (so "zz<24 hex>", "v1.<24 hex>" and "sha:hex" leak) and the
    short runs (under 8) add up to at most SHORT_HEX_BUDGET digits (so colon-joined "ab:cd:..." leaks).
    Two 40-hex groups on any other command (echo, printf), any other line, or on lines with other text, are one
    80-hex value, not two SHAs."""
    start = text.rfind("\n", 0, m.start()) + 1
    end = text.find("\n", m.end())
    lines = text[start:len(text) if end < 0 else end].splitlines()
    if len(lines) == 1 and REVISION_LINE.fullmatch(lines[0]):
        runs = HEX_ANY.findall(lines[0])
        long_runs = [r for r in runs if len(r) >= 8]
        short_digits = sum(len(r) for r in runs if len(r) < 8)
        return (len(long_runs) >= 2 and all(LONE_SHA.fullmatch(r) for r in long_runs)
                and short_digits <= SHORT_HEX_BUDGET)
    return len(lines) >= 2 and all(LONE_SHA.fullmatch(line.strip()) for line in lines)


def specs(suite):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from specs(child)


def scenarios(report):
    """One entry per test of each spec: a spec run in several projects (desktop and mobile) shows each run, labelled."""
    for suite in report["suites"]:
        for spec in specs(suite):
            for test in spec["tests"]:
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
                project = test.get("projectName", "")
                yield {
                    "shots": shots,
                    "title": spec["title"] + (f" [{project}]" if len(spec["tests"]) > 1 and project else ""),
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
            groups = HEX_GROUP.findall(m.group(0))
            digits = sum(len(g) for g in groups)
            if digits >= 64 and not is_sha_stack(text, m):
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


EXCEPTIONS = Path(__file__).resolve().parent.parent / "specs" / "red-green-exceptions.txt"


def exception_lines():
    """The active lines of specs/red-green-exceptions.txt, so a reviewer of the page sees what red_green may skip."""
    try:
        lines = EXCEPTIONS.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]


def render(scens, rev, exceptions=()):
    parts = [f"<!doctype html><meta charset=utf-8><title>Convoz proof</title><style>{CSS}</style>",
             f"<h1>Convoz use-proof</h1><div class=meta>commit {html.escape(rev)} &middot; {len(scens)} scenarios &middot; leak scan clean</div>"]
    if exceptions:
        items = "".join(f"<li>{html.escape(e)}</li>" for e in exceptions)
        parts.append(f"<section><h2>Red/green exceptions in specs/red-green-exceptions.txt</h2>"
                     f"<div class=meta>red_green.py applies only the lines this PR added.</div><ul>{items}</ul></section>")
    for s in scens:
        cls = "ok" if s["status"] == "expected" else "bad"
        tags = "".join(f"<span class=tag>@{html.escape(t.lstrip('@'))}</span>" for t in s["tags"])
        # Every screenshot of the run (mobile attaches dark and light). Screenshots are pixels: the leak scan reads text only.
        shot = "".join(f"<img alt='screenshot' style='max-width:48%;margin:8px 8px 0 0;vertical-align:top' src='data:image/png;base64,{b}'>" for b in s.get("shots", []))
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
    out.write_text(render(scens, commit(), exception_lines()))
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
    hex64 = hashlib.sha256(b"self-test").hexdigest()
    long_secret = base64.urlsafe_b64encode(bytes((i * 53 + 7) % 256 for i in range(80))).decode().rstrip("=")
    sha_a, sha_b = hashlib.sha1(b"a").hexdigest(), hashlib.sha1(b"b").hexdigest()
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
        ("stacked 40-char git SHAs", "".join(hashlib.sha1(n).hexdigest() + "\n" for n in (b"alpha", b"beta", b"gamma")), set()),
        ("two SHA arguments on a recorded command line", "$ git diff " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + " --stat\n", set()),
        ("two SHA arguments to the red/green checker", "$ python3 -I ./scripts/red_green.py " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + " --runner r\n", set()),
        ("two 40-hex words on a recorded command that is not git", "$ echo " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + "\n", {"split hex"}),
        ("80 hex as two 40-hex groups on one line", hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + "\n", {"split hex"}),
        ("80 hex as two 40-hex lines with text before the first", "key " + hashlib.sha1(b"a").hexdigest() + "\n" + hashlib.sha1(b"b").hexdigest() + "\n", {"split hex"}),
        ("80 hex in one run", hashlib.sha1(b"a").hexdigest() + hashlib.sha1(b"b").hexdigest() + "\n", {"hex"}),
        ("64 hex wrapped 40+24", hex64[:40] + "\n" + hex64[40:] + "\n", {"split hex"}),
        ("64 hex wrapped 33+31", hex64[:33] + "\n" + hex64[33:] + "\n", {"split hex"}),
        ("over-length secret after challenge", '{"challenge":"' + long_secret + '"}\n', {"base64"}),
        ("over-length secret after signature", '{"signature":"' + long_secret + long_secret + '"}\n', {"base64"}),
        ("64 hex split 32/32 over a line break", hex16 * 2 + "\n" + hex16 * 2 + "\n", {"split hex"}),
        ("WebAuthn challenge field", '{"publicKey":{"challenge":"' + plain_kek.rstrip("=").replace("+", "-").replace("/", "_") + '"}}\n', set()),
        ("the same bytes outside a WebAuthn field", 'kek ' + plain_kek.rstrip("=").replace("+", "-").replace("/", "_") + "\n", {"base64"}),
        ("TESTONLY token in a URL", "open https://convoz.testonly.ts.net/bootstrap#cvz_b_TESTONLY" + "aB3" * 14 + "\n", set()),
        ("long real-looking token", "tok cvz_b_" + "aB3" * 15 + "\n", {"token", "base64"}),
        ("PEM", "-----BEGIN PRIVATE KEY-----\n", {"PEM header"}),
        ("empty transcript", "\n", {"empty transcript"}),
        ("benign output", benign, set()),
        ("SHAs chained after a git command with a semicolon", "$ git status; echo " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + "\n", {"split hex"}),
        ("a $TMP scratch path on the red/green line", "$ python3 -I ./scripts/red_green.py " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + " --runner $TMP/x-1/runner\n", set()),
        ("SHAs inside a command substitution", "$ git diff $(echo " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + ")\n", {"split hex"}),
        ("SHAs inside backticks", "$ git diff `echo " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + "`\n", {"split hex"}),
        ("SHAs after a redirect", "$ git diff " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + " > out\n", {"split hex"}),
        ("SHAs then a colon-joined hex tail on a git log line", "$ git log " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + " " + ":".join(hashlib.sha1(b"c").hexdigest()[i:i + 2] for i in range(0, 40, 2)) + "\n", {"split hex"}),
        ("a SHA then a colon-joined hex tail on a git show line", "$ git show " + hashlib.sha1(b"a").hexdigest() + ":" + hashlib.sha1(b"b").hexdigest()[:30] + "\n", {"split hex"}),
        ("SHAs piped after a git command", "$ git log | echo " + hashlib.sha1(b"a").hexdigest() + " " + hashlib.sha1(b"b").hexdigest() + "\n", {"split hex"}),
        ("a prefix word glued to hex between two SHAs", "$ git log " + sha_a + " zz" + hex64[:24] + " " + sha_b + "\n", {"split hex"}),
        ("a dotted v1 prefix on hex between two SHAs", "$ git log " + sha_a + " v1." + hex64[:24] + " " + sha_b + "\n", {"split hex"}),
        ("a range of two SHAs", "$ git log " + sha_a + ".." + sha_b + "\n", set()),
    ]
    failed = 0
    for title, text, want in cases:
        got = {kind for _, kind, _ in leaks([{"title": title, "transcript": text}])}
        if got != want:
            failed += 1
            print(f"FAIL {title}: want {sorted(want)}, got {sorted(got)}", file=sys.stderr)
    failed += self_test_multi_test()
    failed += self_test_run(plain_kek)
    print("self-test failed" if failed else "self-test ok", file=sys.stderr if failed else sys.stdout)
    return 1 if failed else 0


def self_test_multi_test():
    """A spec run in two projects renders two labelled sections, each with its screenshots."""
    with tempfile.TemporaryDirectory(prefix="proof-self-test-") as tmp:
        shot = Path(tmp) / "a.png"
        shot.write_bytes(b"\x89PNG")
        body = base64.b64encode(b"ok\n").decode()
        att = [{"name": "transcript", "body": body}, {"name": "screenshot", "contentType": "image/png", "path": str(shot)}]
        tests = [{"projectName": n, "status": "expected", "results": [{"duration": 1, "attachments": att}]} for n in ("chromium", "mobile")]
        report = {"suites": [{"specs": [{"title": "t", "tags": [], "tests": tests}]}]}
        scens = list(scenarios(report))
        page = render(scens, "x", ["A | because <b>"])
        problems = []
        if "A | because &lt;b&gt;" not in page:
            problems.append("exception lines must be on the page, escaped")
        if [s["title"] for s in scens] != ["t [chromium]", "t [mobile]"]:
            problems.append(f"titles {[s['title'] for s in scens]}")
        if page.count("data:image/png") != 2:
            problems.append("each run must show its screenshot")
        for p in problems:
            print(f"FAIL multi-test: {p}", file=sys.stderr)
        return len(problems)


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
