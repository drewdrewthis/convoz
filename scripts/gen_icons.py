"""Draw the Convoz app icons (a blue "C" ring on near-black) into the web app's public dir. Run once; the PNGs are committed.

Usage: python3 -I scripts/gen_icons.py apps/web/public
Writes assets/icon-192.png, assets/icon-512.png, apple-touch-icon.png and favicon.ico under the given directory (the
paths the server serves them at).
"""
import math, struct, sys, zlib
from pathlib import Path

BG, FG = (14, 15, 17), (76, 141, 255)


def pixel(x, y, n):
    """Colour at (x, y) of an n x n icon: a ring with a gap on the right, 2x2 supersampled."""
    out = [0, 0, 0]
    for dx in (0.25, 0.75):
        for dy in (0.25, 0.75):
            u, v = (x + dx) / n - 0.5, (y + dy) / n - 0.5
            r, a = math.hypot(u, v), math.degrees(math.atan2(v, u))
            ring = 0.19 <= r <= 0.31 and abs(a) > 38
            cap = any(math.hypot(u - 0.25 * math.cos(math.radians(s * 38)), v - 0.25 * math.sin(math.radians(s * 38))) <= 0.06 for s in (1, -1))
            c = FG if ring or cap else BG
            out = [o + k for o, k in zip(out, c)]
    return tuple(o // 4 for o in out)


def png(n):
    rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y, n)) for x in range(n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def ico(data, n):
    return struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", n, n, 0, 0, 1, 32, len(data), 22) + data


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    (out / "assets").mkdir(exist_ok=True)
    for name, n in (("assets/icon-192.png", 192), ("assets/icon-512.png", 512), ("apple-touch-icon.png", 180)):
        (out / name).write_bytes(png(n))
    (out / "favicon.ico").write_bytes(ico(png(48), 48))
