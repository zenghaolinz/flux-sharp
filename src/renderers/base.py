from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from src.camera import CameraParams


@dataclass(frozen=True)
class RenderResult:
    output_path: str
    backend: str
    mode: str
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RenderBackend(ABC):
    name = "base"

    @abstractmethod
    def render(
        self,
        ply_path: str | Path,
        camera: CameraParams,
        output_path: str | Path,
    ) -> RenderResult:
        pass
