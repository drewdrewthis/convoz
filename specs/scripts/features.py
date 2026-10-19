#!/usr/bin/env python3
"""Generate docs/features.md, the list of what Convoz does, from specs/features/*.feature.

Usage: python3 -I specs/scripts/features.py --write | --check
--check exits 1 when docs/features.md is out of date. Output is deterministic.
Reuses the parser in check_specs.py. Prototype-parity and app-regress files are tests, not features, so they are left out.
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "docs", "features.md")
BLOB = "https://github.com/drewdrewthis/convoz/blob/feat/web-react/specs/features/"
SKIP_PREFIX = ("prototype-parity", "app-regress")
HIDDEN_TAGS = {"@later", "@wip", "@manual"}


def load_parser():
    spec = importlib.util.spec_from_file_location("check_specs", os.path.join(HERE, "check_specs.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def feature_head(path):
    """Title and one-sentence purpose (the 'So that' line) of a feature file."""
    title, purpose = "", ""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if s.startswith("Feature:"):
                title = s[len("Feature:"):].strip()
            elif s.startswith("So that"):
                purpose = s[len("So that"):].strip()
                break
    return title, purpose


def slug(title):
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", title.lower()))


def render():
    cs = load_parser()
    errors = []
    d = os.path.join(ROOT, "specs", "features")
    sections = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".feature") or fn.startswith(SKIP_PREFIX):
            continue
        path = os.path.join(d, fn)
        shown = [s for s in cs.parse(path, "features", errors) if not set(s.tags) & HIDDEN_TAGS]
        title, purpose = feature_head(path)
        sections.append((title, purpose, fn, shown))
    if errors:
        sys.exit("\n".join(errors))
    sections.sort(key=lambda x: x[0].lower())

    out = [
        "# Convoz features",
        "",
        "Generated from `specs/features/*.feature` by `python3 -I specs/scripts/features.py --write`. "
        "Do not edit by hand: CI fails when this file is stale.",
        "",
        "Each scenario links to its spec line. Scenarios tagged `@later` are not listed.",
        "",
        "## Contents",
        "",
        *[f"- [{t}](#{slug(t)}) ({len(sc)})" for t, _, _, sc in sections],
        "",
    ]
    for title, purpose, fn, shown in sections:
        out += [f"## {title}", "", f"{purpose[:1].upper() + purpose[1:]}." if purpose else "", f"{len(shown)} scenarios.", ""]
        rules = []
        for sc in shown:
            if not rules or rules[-1][0] != sc.rule:
                rules.append((sc.rule, []))
            rules[-1][1].append(sc)
        for rule, scs in rules:
            pad = ""
            if rule:
                out.append(f"- **{rule}**")
                pad = "  "
            out += [f"{pad}- [{s.name}]({BLOB}{fn}#L{s.line})" for s in scs]
        out.append("")
    return "\n".join(out).rstrip("\n").replace("\n\n\n", "\n\n") + "\n"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("--write", "--check"):
        print(__doc__)
        return 2
    text = render()
    if mode == "--write":
        with open(OUT, "w", encoding="utf-8") as fh:
            fh.write(text)
        return 0
    return main_check(text)


def main_check(text=None):
    text = text if text is not None else render()
    cur = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else None
    if cur != text:
        print("docs/features.md is out of date. Run: python3 -I specs/scripts/features.py --write")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
