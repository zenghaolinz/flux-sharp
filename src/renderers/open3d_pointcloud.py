from __future__ import annotations

from pathlib import Path

import numpy as np

from src.camera import CameraParams
from src.ply_loader import load_ply
from src.renderers.base import RenderBackend, RenderResult


class Open3DPointCloudRenderer(RenderBackend):
    name = "open3d"

    def __init__(
        self,
        background: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
    ) -> None:
        self.background = background

    def render(
        self,
        ply_path: str | Path,
        camera: CameraParams,
        output_path: str | Path,
    ) -> RenderResult:
        o3d = _import_open3d()
        point_cloud = load_ply(ply_path)
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        renderer = o3d.visualization.rendering.OffscreenRenderer(camera.width, camera.height)
        try:
            renderer.scene.set_background(self.background)
            material = o3d.visualization.rendering.MaterialRecord()
            material.shader = "defaultUnlit"
            material.point_size = 3.0
            renderer.scene.add_geometry("ply", point_cloud, material)

            bounds = point_cloud.get_axis_aligned_bounding_box()
            center = bounds.get_center()
            extent = max(float(np.linalg.norm(bounds.get_extent())), 1.0)
            eye = camera.eye(center)
            if np.linalg.norm(eye - center) < 1e-6:
                eye = center + np.array([0.0, 0.0, extent], dtype=float)

            up = camera.rotation_matrix() @ np.array([0.0, 1.0, 0.0], dtype=float)
            renderer.setup_camera(camera.fov, center, eye, up)

            image = renderer.render_to_image()
            o3d.io.write_image(str(output), image)
        finally:
            renderer.release_resources()

        return RenderResult(
            output_path=str(output),
            backend=self.name,
            mode="open3d-point-cloud",
            notes=[
                "Open3D preview renderer. It may ignore SHARP/3DGS Gaussian attributes."
            ],
        )


def _import_open3d():
    try:
        import open3d as o3d  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Open3D is required to render PLY files. Install it with: pip install open3d"
        ) from exc
    return o3d
