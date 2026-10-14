#!/usr/bin/env python3
"""生成 DSHarbor 图标源图：1024×1024 PNG，纯标准库绘制，无外部依赖。

图案：深蓝底 + 白色圆环 + 中心圆点（港口/锚点的抽象意象）。
生成后交给 `pnpm tauri icon` 派生各平台需要的尺寸与 .ico/.icns。
"""
import pathlib
import struct
import zlib

SIZE = 1024
SUPERSAMPLE = 2  # 2×2 超采样做简易抗锯齿
BG = (27, 42, 74)  # #1B2A4A 深蓝
FG = (245, 248, 255)  # 近白

CX = CY = SIZE / 2
R_OUTER, R_INNER = 330, 235  # 圆环外/内半径
DOT_R = 88


def sample(px: float, py: float) -> tuple[int, int, int]:
    d = ((px - CX) ** 2 + (py - CY) ** 2) ** 0.5
    if R_INNER <= d <= R_OUTER or d <= DOT_R:
        return FG
    return BG


rows = bytearray()
step = 1.0 / SUPERSAMPLE
for y in range(SIZE):
    rows.append(0)  # PNG 每行前置 filter 字节
    for x in range(SIZE):
        r = g = b = 0
        for sy in range(SUPERSAMPLE):
            for sx in range(SUPERSAMPLE):
                cr, cg, cb = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step)
                r += cr
                g += cg
                b += cb
        n = SUPERSAMPLE * SUPERSAMPLE
        rows.extend((r // n, g // n, b // n))


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
png += chunk(b"IEND", b"")

out = pathlib.Path(__file__).resolve().parent.parent / "assets" / "icon-source.png"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(png)
print(f"已生成 {out} ({len(png)} 字节)")
