from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
from typing import Any

import numpy as np


@dataclass(frozen=True)
class CameraParams:
    x: float = 0.0
    y: float = 0.0
    z: float = 2.5
    pitch: float = 0.0
    yaw: float = 0.0
    roll: float = 0.0
    fov: float = 45.0
    width: int = 1024
    height: int = 1024

    @classmethod
    def from_json(cls, path: str | Path) -> "CameraParams":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CameraParams":
        params = cls(**data)
        params.validate()
        return params

    def to_json(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(asdict(self), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def validate(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("Camera width and height must be positive.")
        if not 1.0 <= self.fov <= 179.0:
            raise ValueError("Camera fov must be between 1 and 179 degrees.")

    def rotation_matrix(self) -> np.ndarray:
        """Return roll * pitch * yaw rotation matrix in degrees."""
        yaw = math.radians(self.yaw)
        pitch = math.radians(self.pitch)
        roll = math.radians(self.roll)

        ry = np.array(
            [
                [math.cos(yaw), 0.0, math.sin(yaw)],
                [0.0, 1.0, 0.0],
                [-math.sin(yaw), 0.0, math.cos(yaw)],
            ],
            dtype=float,
        )
        rx = np.array(
            [
                [1.0, 0.0, 0.0],
                [0.0, math.cos(pitch), -math.sin(pitch)],
                [0.0, math.sin(pitch), math.cos(pitch)],
            ],
            dtype=float,
        )
        rz = np.array(
            [
                [math.cos(roll), -math.sin(roll), 0.0],
                [math.sin(roll), math.cos(roll), 0.0],
                [0.0, 0.0, 1.0],
            ],
            dtype=float,
        )
        return rz @ rx @ ry

    def eye(self, scene_center: np.ndarray | None = None) -> np.ndarray:
        center = np.zeros(3, dtype=float) if scene_center is None else scene_center
        offset = np.array([self.x, self.y, self.z], dtype=float)
        return center + self.rotation_matrix() @ offset
