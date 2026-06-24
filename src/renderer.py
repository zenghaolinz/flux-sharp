from __future__ import annotations

from pathlib import Path

from .camera import CameraParams
from .renderers import create_render_backend
from .renderers.software import render_point_cloud_to_image


def render_ply_to_image(
    ply_path: str | Path,
    camera: CameraParams,
    output_path: str | Path,
    background: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
) -> str:
    return create_render_backend("auto").render(ply_path, camera, output_path).output_path


def render_point_cloud_software(
    point_cloud,
    camera: CameraParams,
    output_path: str | Path,
    background: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
) -> str:
    return render_point_cloud_to_image(point_cloud, camera, output_path, background)
