#!/usr/bin/env python3
"""Decide whether a change may take the fast lane (a lighter gate) or needs the FULL GATE.

Usage: python3 -I scripts/fast_lane.py [BASE_REF]     (default origin/feat/web-react; run inside the git repo)
       python3 -I scripts/fast_lane.py --rules        (print the rules, for a PR body)

Prints ELIGIBLE (exit 0), or FULL GATE plus each disallowed file and why (exit 1).
A file is allowed only under ALLOW. DENY wins over ALLOW. Any added line that issues a
write call (WRITE_CALL) also forces the FULL GATE, whatever the path.
"""
import fnmatch
import re
import subprocess
import sys

DEFAULT_BASE = "origin/feat/web-react"

# Only these paths may ride the fast lane.
ALLOW = [
    "apps/web/src/*",  # screens, components, styles
    "specs/*",
]

# Disallowed even inside ALLOW. (glob, why). fnmatch: "*" also crosses "/".
DENY = [
    ("apps/web/src/sw/*", "service worker and its window-side registry"),
    ("apps/web/src/main.tsx", "calls registerServiceWorker()"),
    ("apps/web/src/features/notifications/push.ts", "registers the service worker (ensureServiceWorker)"),
    ("apps/web/src/features/notifications/support.ts", "service worker support checks"),
    ("apps/web/src/shared/data.ts", "references the service worker"),
    ("apps/web/src/features/auth/*", "sign-in and recovery"),
    ("apps/web/src/features/onboarding/*", "passkey enrolment and bootstrap"),
    ("apps/web/src/features/settings/Passkeys.tsx", "passkey management"),
    ("apps/web/src/features/settings/AddPasskeySheet.tsx", "passkey enrolment"),
    ("apps/web/src/features/settings/RecoveryCodes.tsx", "recovery codes"),
    ("apps/web/src/features/settings/Account.tsx", "account and session"),
    ("apps/web/src/shared/ceremony.ts", "WebAuthn ceremony"),
    ("apps/web/src/shared/api.ts", "the API client (all writes go through it)"),
    ("apps/web/src/shared/uploads.ts", "upload writes"),
    ("apps/web/src/early.ts", "runs before the app boots"),
    ("apps/web/src/shared/early.ts", "runs before the app boots"),
    ("apps/web/vite.config.ts", "build config"),
    ("apps/web/tsconfig*.json", "build config"),
    ("apps/web/package.json", "dependencies and build scripts"),
    ("apps/web/index.html", "build entry"),
    ("*/package.json", "dependencies and build scripts"),
    ("package.json", "dependencies and build scripts"),
    ("*vite.config.*", "build config"),
    ("*tsconfig*.json", "build config"),
]

# An added line that issues a write call.
WRITE_CALL = re.compile(
    r"\bclient\s*\.\s*(POST|PUT|PATCH|DELETE)\b"
    r"|\bmethod\s*:\s*[\"'`](POST|PUT|PATCH|DELETE)[\"'`]"
    r"|\.(post|put|patch|delete)\s*\(",
    re.IGNORECASE,
)


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def changed_files(base):
    mb = git("merge-base", base, "HEAD").strip()
    return [f for f in git("diff", "--name-only", "--no-renames", mb, "HEAD").splitlines() if f], mb


def added_write_calls(path, mb):
    out = git("diff", "--no-renames", "-U0", mb, "HEAD", "--", path)
    return [l[1:].strip() for l in out.splitlines() if l.startswith("+") and not l.startswith("+++") and WRITE_CALL.search(l)]


def check(files, write_lines=lambda f: []):
    """Return [(file, reason)] for every file that bars the fast lane."""
    bad = []
    for f in files:
        deny = next((why for g, why in DENY if fnmatch.fnmatchcase(f, g)), None)
        if deny:
            bad.append((f, deny))
        elif not any(fnmatch.fnmatchcase(f, g) for g in ALLOW):
            bad.append((f, "outside apps/web/src and specs/"))
        else:
            w = write_lines(f)
            if w:
                bad.append((f, "adds a write call: " + w[0]))
    return bad


def rules_text():
    lines = ["Allowed (and nothing else):"] + [f"  {g}" for g in ALLOW]
    lines += ["Denied even inside the allowed paths:"] + [f"  {g}  # {why}" for g, why in DENY]
    lines.append("Any added line matching " + WRITE_CALL.pattern + "  # issues a write call")
    return "\n".join(lines)


def main(argv):
    if "--rules" in argv:
        print(rules_text())
        return 0
    base = argv[0] if argv else DEFAULT_BASE
    files, mb = changed_files(base)
    bad = check(files, lambda f: added_write_calls(f, mb))
    if not bad:
        print("ELIGIBLE")
        return 0
    print("FULL GATE")
    for f, why in bad:
        print(f"  {f}: {why}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
