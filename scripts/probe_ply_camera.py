"""Probe SHARP PLY camera parameters (extrinsic/intrinsic/image_size)."""
import struct
from pathlib import Path

ply = Path("inputs/IMG_2638_39d5e74b.ply")

with ply.open("rb") as f:
    header_lines = []
    header_bytes = 0
    for raw in f:
        header_bytes += len(raw)
        line = raw.decode("ascii", errors="replace").strip()
        header_lines.append(line)
        if line == "end_header":
            break

# Parse elements
elements = []
cur_elem = None
for line in header_lines[1:]:
    parts = line.split()
    if parts[:2] == ["element", "vertex"]:
        cur_elem = {"name": "vertex", "count": int(parts[2]), "props": []}
        elements.append(cur_elem)
    elif parts[0] == "element":
        cur_elem = {"name": parts[1], "count": int(parts[2]), "props": []}
        elements.append(cur_elem)
    elif parts[0] == "property" and cur_elem:
        cur_elem["props"].append((parts[1], parts[-1]))

TYPE_MAP = {
    "float": ("f", 4), "int": ("i", 4), "uint": ("I", 4), "uchar": ("B", 1),
}

with ply.open("rb") as f:
    f.seek(header_bytes)
    for elem in elements:
        count = elem["count"]
        props = elem["props"]
        fmt_parts = []
        byte_size = 0
        for ptype, _pname in props:
            sc, sz = TYPE_MAP[ptype]
            fmt_parts.append(sc)
            byte_size += sz
        fmt = "<" + ("".join(fmt_parts)) * count
        total = byte_size * count
        name = elem["name"]
        if name == "vertex":
            f.seek(total, 1)  # skip vertex binary data
            print(f"Vertex: {count} entries ({byte_size} bytes each, skipped)")
            continue
        raw = f.read(total)
        vals = struct.unpack(fmt, raw)
        if name == "extrinsic":
            print(f"Extrinsic ({count} floats):")
            for r in range(4):
                row = vals[r * 4 : (r + 1) * 4]
                print(f"  [{row[0]:10.6f} {row[1]:10.6f} {row[2]:10.6f} {row[3]:10.6f}]")
        elif name == "intrinsic":
            print(f"\nIntrinsic ({count} floats):")
            for r in range(3):
                row = vals[r * 3 : (r + 1) * 3]
                print(f"  [{row[0]:10.6f} {row[1]:10.6f} {row[2]:10.6f}]")
        elif name == "image_size":
            print(f"\nImage size: {vals}")
        elif name == "frame":
            print(f"Frame: {vals}")
        elif name == "disparity":
            print(f"Disparity: {vals}")
        elif name == "color_space":
            print(f"Color space: {vals}")
        elif name == "version":
            print(f"Version: {vals}")
        elif name == "vertex":
            print(f"Vertex: {count} entries ({byte_size} bytes each, skipped)")
