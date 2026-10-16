#!/usr/bin/env python3
"""Generate the confusables table that identity.Skeleton reads (UTS #39, design I-3).

Usage: python3 -I scripts/gen_confusables.py <confusables.txt>
Reads the pinned Unicode file, checks its SHA-256 against PINNED_SHA256 and writes
apps/convoz/internal/server/identity/confusables.tsv: one "<source hex>\t<target hex> <target hex>..." line per
entry of the MA table (mixed-script, any-case). scripts/check_pins.py checks that the table's header names the pin.
Source: https://www.unicode.org/Public/18.0.0/security/confusables.txt
"""
import hashlib
import os
import re
import sys

PINNED_URL = "https://www.unicode.org/Public/18.0.0/security/confusables.txt"
PINNED_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "apps", "convoz", "internal", "server", "identity", "confusables.tsv")
ENTRY = re.compile(r"^﻿?([0-9A-F]{4,6}) ;\t([0-9A-F ]+) ;\tMA\b")


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    raw = open(argv[1], "rb").read()
    if hashlib.sha256(raw).hexdigest() != PINNED_SHA256:
        print(f"gen_confusables: {argv[1]} is not the pinned file ({PINNED_URL}, sha256 {PINNED_SHA256})", file=sys.stderr)
        return 1
    rows = []
    for line in raw.decode("utf-8").splitlines():
        m = ENTRY.match(line)
        if m:
            rows.append(f"{m.group(1)}\t{m.group(2).strip()}")
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f"# source: {PINNED_URL}\n# sha256: {PINNED_SHA256}\n")
        fh.write("\n".join(rows) + "\n")
    print(f"gen_confusables: {len(rows)} entries -> {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
