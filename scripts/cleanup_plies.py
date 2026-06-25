"""One-time cleanup: delete redundant PLY files and create photo→PLY manifest.

Scans inputs/*.ply, groups by base photo name (strips trailing _{8hexchars}),
keeps only the newest PLY per group, deletes the rest, and writes
web_uploads/manifest.json mapping base names to kept PLY paths.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # project root (scripts/../)
INPUTS = ROOT / "inputs"
MANIFEST = ROOT / "web_uploads" / "manifest.json"

# Matches: <base_name>_<8 hex chars>.ply  →  group(1) = base_name
_PLY_HASH_RE = re.compile(r"^(.+?)_([0-9a-f]{8})\.ply$")


def cleanup_and_build_manifest() -> dict[str, str]:
    ply_files = sorted(INPUTS.glob("*.ply"))
    if not ply_files:
        print("[cleanup] No PLY files found in inputs/.")
        return {}

    # Group PLY files by base photo name.
    groups: dict[str, list[Path]] = {}
    for ply in ply_files:
        m = _PLY_HASH_RE.match(ply.name)
        base = m.group(1) if m else ply.stem
        groups.setdefault(base, []).append(ply)

    manifest: dict[str, str] = {}
    deleted_count = 0
    kept_count = 0

    for base_name, files in sorted(groups.items()):
        # Sort newest-first by mtime.
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        latest = files[0]
        manifest[base_name] = str(latest.relative_to(ROOT))
        kept_count += 1

        for f in files[1:]:
            f.unlink()
            deleted_count += 1
            print(f"  [deleted] {f.name}")

    print(f"\n[cleanup] Kept {kept_count} PLY(s), deleted {deleted_count} redundant.")
    print(f"[cleanup] Manifest written to {MANIFEST.relative_to(ROOT)}")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    return manifest


if __name__ == "__main__":
    cleanup_and_build_manifest()
