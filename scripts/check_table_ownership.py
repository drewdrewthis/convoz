#!/usr/bin/env python3
"""Go boundary check "table-ownership" (design §4.3, AC-16).

Usage: python3 -I scripts/check_table_ownership.py
Every CREATE TABLE in the migrations has an "-- owner: <module>" line above it. Each server module's own SQL
(queries/*.sql, and the SQL string literals in its .go files) may name only tables that module owns. A table
named in another module's SQL fails as "<file>:<line>: module <m> uses table <t> owned by <o>".
httpapi and testroutes (composition roots) hold no SQL: any SQL-shaped literal or .sql file there fails as
"<file>:<line>: composition root <r> holds SQL". Dynamic SQL is not seen: this is a guard rail,
not a proof.
Exit 0 when clean, 1 on a break.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "apps", "convoz", "internal", "server")
MIGRATIONS = os.path.join(SERVER_DIR, "platform", "migrations")
ROOTS = {"httpapi", "testroutes"}
OWNER = re.compile(r"^--\s*owner:\s*(\w+)\s*$")
CREATE = re.compile(r"^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", re.I)
USE = re.compile(r"\b(?:JOIN|INTO|UPDATE)\s+(\w+)", re.I)
# After FROM comes a list of tables and subqueries separated by commas; it ends at a clause keyword, a ";"
# or the ")" that closes the enclosing subquery. Scanned by hand so a comma after a subquery still counts.
FROM_WORD = re.compile(r"\bFROM\s+", re.I)
CLAUSE_END = re.compile(r"(?:WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|JOIN|LEFT|RIGHT|INNER|CROSS|NATURAL|ON|SET)\b", re.I)
# What counts as SQL in a composition root (which must hold none).
SQL_SHAPE = re.compile(r"\bSELECT\s[\w*,\s.()]+?\sFROM\s+\w|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w|\bDELETE\s+FROM\s+\w|\bUPDATE\s+\w+\s+SET\b", re.I)


def owners(problems):
    """table -> owning module, from the migrations."""
    out = {}
    for name in sorted(os.listdir(MIGRATIONS)):
        if not name.endswith(".sql"):
            continue
        owner = None
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                m = OWNER.match(line.strip())
                if m:
                    owner = m.group(1)
                    continue
                c = CREATE.match(line)
                if c:
                    if owner is None:
                        problems.append(f"internal/server/platform/migrations/{name}:{n}: table {c.group(1)} has no '-- owner: <module>' line")
                    else:
                        out[c.group(1).lower()] = owner
                    owner = None
                elif line.strip() and not line.lstrip().startswith("--"):
                    owner = None
    return out


def go_strings(text):
    """(offset, literal text) for each string literal of a Go file; comments are skipped."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            i = text.find("\n", i)
            i = n if i < 0 else i
        elif text.startswith("/*", i):
            i = text.find("*/", i)
            i = n if i < 0 else i + 2
        elif c in "\"`'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" and c != "`" else 1
            if c != "'":
                out.append((i + 1, text[i + 1:j]))
            i = j + 1
        else:
            i += 1
    return out


def sql_chunks(path):
    """(offset, sql text) pieces of one file: all of a .sql file (comments stripped), the literals of a .go file."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if path.endswith(".sql"):
        return text, [(0, re.sub(r"--[^\n]*", lambda m: " " * len(m.group(0)), text))]
    if path.endswith(".go") and not path.endswith("_test.go"):
        return text, go_strings(text)
    return text, []


def from_items(chunk, start):
    """(offset, text) of each comma-separated item of the FROM list that begins at `start`."""
    items, depth, item_start, i = [], 0, start, start
    while i < len(chunk):
        c = chunk[i]
        if c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and (c == ";" or (CLAUSE_END.match(chunk, i) and not chunk[i - 1].isalnum() and chunk[i - 1] != "_")):
            break
        elif depth == 0 and c == ",":
            items.append((item_start, chunk[item_start:i]))
            item_start = i + 1
        i += 1
    items.append((item_start, chunk[item_start:i]))
    return items


def tables_in(chunk):
    """(offset, lowercase table name) for each table a piece of SQL reads or writes."""
    found = [(m.start(1), m.group(1).lower()) for m in USE.finditer(chunk)]
    for m in FROM_WORD.finditer(chunk):
        for pos, item in from_items(chunk, m.end()):
            word = re.match(r"\s*(\w+)", item)
            if word and not item.lstrip().startswith("("):
                found.append((pos + word.start(1), word.group(1).lower()))
    return found


def main():
    problems = []
    table_owner = owners(problems)
    for module in sorted(os.listdir(SERVER_DIR)):
        mdir = os.path.join(SERVER_DIR, module)
        if not os.path.isdir(mdir):
            continue
        for base, _, files in os.walk(mdir):
            if os.sep + "migrations" in base:
                continue
            for fn in sorted(files):
                path = os.path.join(base, fn)
                text, chunks = sql_chunks(path)
                rel = os.path.relpath(path, os.path.join(ROOT, "apps", "convoz")).replace(os.sep, "/")
                for offset, chunk in chunks:
                    if module in ROOTS:
                        m = SQL_SHAPE.search(chunk)
                        if m:
                            line = text.count("\n", 0, offset + m.start()) + 1
                            problems.append(f"{rel}:{line}: composition root {module} holds SQL (move it into a module)")
                        continue
                    for start, table in tables_in(chunk):
                        if table in table_owner and table_owner[table] != module:
                            line = text.count("\n", 0, offset + start) + 1
                            problems.append(f"{rel}:{line}: module {module} uses table {table} owned by {table_owner[table]}")
    for p in problems:
        print(p)
    print("table-ownership: " + (f"{len(problems)} problem(s)" if problems else "ok"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
