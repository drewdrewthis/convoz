"""The one place scripts find the Go tool: $GO_BIN, else `go` on PATH. Never a fixed install path."""
import os
import shutil


def go_bin():
    path = os.environ.get("GO_BIN") or shutil.which("go")
    if not path:
        raise SystemExit("go not found: put go on PATH or set GO_BIN")
    return path
