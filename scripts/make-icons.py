#!/usr/bin/env python3
"""LOT 10 — Génère le jeu d'icônes Tauri sans aucune dépendance externe.

Produit des PNG valides, un .ico (PNG embarqués, Windows Vista+) et un .icns
(chunks PNG, macOS) à partir d'un motif « D » géométrique sur fond ardoise,
avec la bande turquoise du produit. Aucun téléchargement : 100 % hors ligne.

Usage : python3 scripts/make-icons.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

BG = (15, 23, 42, 255)        # #0f172a
TEAL = (20, 184, 166, 255)    # #14b8a6
WHITE = (248, 250, 252, 255)  # #f8fafc


def rounded_rect(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> bool:
    """Appartenance à un rectangle arrondi (distance au rectangle interne)."""
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def pixel(x: int, y: int, size: int) -> tuple[int, int, int, int]:
    # Coordonnées normalisées au centre du pixel, avec antialiasing 2x2.
    color = BG
    for sx, sy in ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)):
        nx, ny = (x + sx) / size, (y + sy) / size

        # Cadre arrondi turquoise.
        in_outer = rounded_rect(nx, ny, 0.06, 0.06, 0.94, 0.94, 0.22)
        in_inner = rounded_rect(nx, ny, 0.13, 0.13, 0.87, 0.87, 0.16)
        c = TEAL if in_outer and not in_inner else BG

        # Lettre « D » : hampe + bol (anneau).
        if 0.29 <= nx <= 0.38 and 0.29 <= ny <= 0.71:
            c = WHITE
        if rounded_rect(nx, ny, 0.34, 0.27, 0.70, 0.73, 0.19) and not rounded_rect(
            nx, ny, 0.41, 0.34, 0.63, 0.66, 0.13
        ):
            c = WHITE

        # Barre d'accent de la marque.
        if 0.29 <= nx <= 0.71 and 0.77 <= ny <= 0.81:
            c = TEAL

        # Un seul échantillon suffit pour les petites tailles ; sinon moyenne.
        if size <= 64:
            color = c
            break
        if sx == 0.25 and sy == 0.25:
            acc = [0, 0, 0, 0]
        for i in range(4):
            acc[i] += c[i]
        if sx == 0.75 and sy == 0.75:
            color = tuple(v // 4 for v in acc)  # type: ignore[assignment]
    return color  # type: ignore[return-value]


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def make_png(size: int) -> bytes:
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filtre PNG « None »
        for x in range(size):
            rows.extend(pixel(x, y, size))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + png_chunk(b"IEND", b"")
    )


def make_ico(images: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = bytearray()
    payload = bytearray()
    for size, data in images:
        width_byte = 0 if size >= 256 else size
        entries.extend(
            struct.pack("<BBBBHHII", width_byte, width_byte, 0, 0, 1, 32, len(data), offset)
        )
        payload.extend(data)
        offset += len(data)
    return header + bytes(entries) + bytes(payload)


def make_icns(images: list[tuple[bytes, bytes]]) -> bytes:
    body = bytearray()
    for kind, data in images:
        body.extend(kind + struct.pack(">I", len(data) + 8) + data)
    return b"icns" + struct.pack(">I", len(body) + 8) + bytes(body)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    sizes = {
        32: make_png(32),
        128: make_png(128),
        256: make_png(256),
        512: make_png(512),
    }
    (ICONS / "32x32.png").write_bytes(sizes[32])
    (ICONS / "128x128.png").write_bytes(sizes[128])
    (ICONS / "128x128@2x.png").write_bytes(sizes[256])
    (ICONS / "icon.png").write_bytes(sizes[512])
    (ICONS / "icon.ico").write_bytes(make_ico([(32, sizes[32]), (256, sizes[256])]))
    (ICONS / "icon.icns").write_bytes(
        make_icns([(b"ic07", sizes[128]), (b"ic08", sizes[256]), (b"ic09", sizes[512])])
    )
    for file in sorted(ICONS.iterdir()):
        print(f"{file.relative_to(ROOT)} — {file.stat().st_size} octets")


if __name__ == "__main__":
    main()
