from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from src.camera import CameraParams
from src.ply_loader import load_preview_vertices
from src.renderers.base import RenderBackend, RenderResult


class SoftwarePointCloudRenderer(RenderBackend):
    name = "software"

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
        points, colors = load_preview_vertices(ply_path)
        render_vertices_to_image(points, colors, camera, output_path, self.background)
        return RenderResult(
            output_path=str(Path(output_path)),
            backend=self.name,
            mode="point-cloud-projection",
            notes=[
                "Fallback preview renderer. It ignores Gaussian scale, rotation, opacity, and SH attributes."
            ],
        )


def render_vertices_to_image(
    points: np.ndarray,
    colors: np.ndarray,
    camera: CameraParams,
    output_path: str | Path,
    background: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
) -> str:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    points = np.asarray(points, dtype=float)
    if points.size == 0:
        raise ValueError("Cannot render an empty point cloud.")

    colors = np.asarray(colors, dtype=float)
    if colors.size == 0:
        colors = np.zeros((len(points), 3), dtype=float)
    colors = np.clip(colors * 255, 0, 255).astype(np.uint8)

    bounds_min = points.min(axis=0)
    bounds_max = points.max(axis=0)
    center = (bounds_min + bounds_max) * 0.5
    extent = max(float(np.linalg.norm(bounds_max - bounds_min)), 1.0)
    eye = camera.eye(center)
    if np.linalg.norm(eye - center) < 1e-6:
        eye = center + np.array([0.0, 0.0, extent], dtype=float)

    forward = center - eye
    forward = forward / max(np.linalg.norm(forward), 1e-9)
    up_hint = camera.rotation_matrix() @ np.array([0.0, 1.0, 0.0], dtype=float)
    right = np.cross(forward, up_hint)
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0.0, 0.0], dtype=float)
    right = right / np.linalg.norm(right)
    up = np.cross(right, forward)

    rel = points - eye
    cam_x = rel @ right
    cam_y = rel @ up
    cam_z = rel @ forward
    visible = cam_z > 1e-5

    bg = tuple(int(np.clip(channel, 0, 1) * 255) for channel in background[:3])
    image = Image.new("RGB", (camera.width, camera.height), bg)
    draw = ImageDraw.Draw(image)
    if not np.any(visible):
        image.save(output)
        return str(output)

    focal = (camera.height * 0.5) / np.tan(np.radians(camera.fov) * 0.5)
    screen_x = (camera.width * 0.5) + (cam_x[visible] * focal / cam_z[visible])
    screen_y = (camera.height * 0.5) - (cam_y[visible] * focal / cam_z[visible])
    depth = cam_z[visible]
    visible_colors = colors[visible]

    order = np.argsort(depth)[::-1]
    radius = max(1, int(round(min(camera.width, camera.height) / 512)))
    for idx in order:
        x = int(round(screen_x[idx]))
        y = int(round(screen_y[idx]))
        if 0 <= x < camera.width and 0 <= y < camera.height:
            color = tuple(int(v) for v in visible_colors[idx])
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

    image.save(output)
    return str(output)


def render_point_cloud_to_image(
    point_cloud,
    camera: CameraParams,
    output_path: str | Path,
    background: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
) -> str:
    points = np.asarray(point_cloud.points, dtype=np.float32)
    colors = np.asarray(point_cloud.colors, dtype=np.float32)
    return render_vertices_to_image(points, colors, camera, output_path, background)
