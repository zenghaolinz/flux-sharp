from __future__ import annotations

import os
from pathlib import Path

from src.renderers.base import RenderBackend, RenderResult
from src.renderers.open3d_pointcloud import Open3DPointCloudRenderer
from src.renderers.sharp_cli import SharpCliRenderer
from src.renderers.software import SoftwarePointCloudRenderer


class AutoRenderer(RenderBackend):
    name = "auto"

    def render(self, ply_path, camera, output_path) -> RenderResult:
        if os.name != "nt":
            try:
                return Open3DPointCloudRenderer().render(ply_path, camera, output_path)
            except RuntimeError:
                pass
        result = SoftwarePointCloudRenderer().render(ply_path, camera, output_path)
        return RenderResult(
            output_path=result.output_path,
            backend=self.name,
            mode=result.mode,
            notes=[
                *result.notes,
                "Auto renderer selected software fallback.",
            ],
        )


def create_render_backend(name: str) -> RenderBackend:
    normalized = name.strip().lower()
    if normalized == "auto":
        return AutoRenderer()
    if normalized == "software":
        return SoftwarePointCloudRenderer()
    if normalized == "open3d":
        return Open3DPointCloudRenderer()
    if normalized in {"sharp", "sharp-cli"}:
        return SharpCliRenderer()
    raise ValueError(f"Unsupported renderer backend: {name}")
