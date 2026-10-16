#!/usr/bin/env python3
"""Release guard: a shipped binary must not carry the test hooks.

Usage: python3 scripts/release_guard.py <binary>
Fails (exit 1) if the binary
  1. was built with -tags=testhooks (read from `go version -m`),
  2. contains the string "/__test/", "TESTONLY" (the fake-token marker) or any "CONVOZ_TEST_" switch
     (CONVOZ_TEST_ADMIN, CONVOZ_TEST_PLAINTEXT, CONVOZ_TEST_POLL_MS ...), or
  3. answers anything but 404 on a /__test/ route when booted with CONVOZ_TEST_ADMIN=1.
The route list comes from the one Go constant (apps/convoz/internal/server/testroutes), so a new test
route is probed without editing this script.
"""
import base64
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GO_DIR = os.path.join(ROOT, "apps", "convoz")


def _go_bin():
    # python -I drops the script directory from sys.path, so load the sibling by path.
    spec = importlib.util.spec_from_file_location("gotool", os.path.join(ROOT, "scripts", "gotool.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.go_bin()


GO = _go_bin()


def test_routes():
    res = subprocess.run([GO, "run", "./cmd/testroutes"], cwd=GO_DIR, capture_output=True, text=True, timeout=120,
                         env=dict(os.environ, GOFLAGS="-mod=readonly"))
    if res.returncode != 0:
        raise SystemExit("cannot list test routes: " + res.stderr)
    return res.stdout.split()


def probe(url, method, host):
    # The wall answers 421 to any Host but the one it serves, so the probe must send that one.
    req = urllib.request.Request(url, method=method, data=b"{}" if method == "POST" else None,
                                 headers={"content-type": "application/json", "Host": host})
    try:
        return urllib.request.urlopen(req, timeout=5).status
    except urllib.error.HTTPError as e:
        return e.code


def boot_and_probe(binary, routes, problems):
    work = tempfile.mkdtemp(prefix="convoz-guard-")
    kek = os.path.join(work, "kek.TESTONLY")
    with open(kek, "w") as fh:
        fh.write(base64.b64encode(b"TESTONLY" + b"." * 24).decode())
    os.chmod(kek, 0o600)
    ready = os.path.join(work, "ready.json")
    env = {"PATH": os.environ.get("PATH", ""), "CONVOZ_TEST_ADMIN": "1"}
    proc = subprocess.Popen([binary, "serve", "--data-dir", os.path.join(work, "data"), "--kek-file", kek,
                             "--listen", "127.0.0.1:0", "--host", "localhost", "--tailscale", "off", "--ready-file", ready],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 15
        listen = None
        while time.time() < deadline and listen is None:
            if proc.poll() is not None:
                break
            try:
                with open(ready) as fh:
                    listen = json.load(fh)["listen"]
            except (OSError, ValueError, KeyError):
                time.sleep(0.05)
        if listen is None:
            problems.append("binary did not become ready, so its test routes could not be probed")
            return
        base = "http://" + listen.removeprefix("tcp://")
        host = "localhost:" + listen.rsplit(":", 1)[1]
        for route in routes:
            # GET alone could pass for a route that only takes POST, so POST follows every 404.
            status = probe(base + route, "GET", host)
            if status != 404:
                problems.append(f"GET {route} answered {status}, must be 404")
                continue
            status = probe(base + route, "POST", host)
            if status != 404:
                problems.append(f"POST {route} answered {status}, must be 404")
    finally:
        if proc.poll() is None:
            proc.terminate()  # our own child handle
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    binary = os.path.abspath(sys.argv[1])
    problems = []
    info = subprocess.run([GO, "version", "-m", binary], capture_output=True, text=True, timeout=60)
    if info.returncode != 0:
        problems.append("go version -m failed: " + info.stderr.strip())
    elif re.search(r"-tags=\S*testhooks", info.stdout):
        problems.append("binary was built with -tags=testhooks")
    with open(binary, "rb") as fh:
        content = fh.read()
    for marker in (b"/__test/", b"TESTONLY", b"CONVOZ_TEST_"):
        if marker in content:
            problems.append(f'binary contains the string "{marker.decode()}"')
    boot_and_probe(binary, test_routes(), problems)
    for p in problems:
        print("release_guard:", p)
    if not problems:
        print("release_guard: ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
