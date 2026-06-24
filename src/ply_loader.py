from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np


@dataclass(frozen=True)
class PlyInfo:
    path: str
    format: str | None
    point_count: int
    has_colors: bool
    vertex_properties: list[str]
    is_gaussian_splat: bool
    bounds_min: list[float]
    bounds_max: list[float]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _import_open3d():
    try:
        import open3d as o3d  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Open3D is required to load PLY files. Install it with: pip install open3d"
        ) from exc
    return o3d


def load_ply(path: str | Path):
    target = Path(path)
    if not target.exists():
        raise FileNotFoundError(f"PLY file does not exist: {target}")
    if target.suffix.lower() != ".ply":
        raise ValueError(f"Expected a .ply file, got: {target}")

    o3d = _import_open3d()
    point_cloud = o3d.io.read_point_cloud(str(target))
    if point_cloud.is_empty():
        raise ValueError(f"Open3D loaded an empty point cloud from: {target}")
    return point_cloud


def read_ply_header(path: str | Path) -> dict[str, Any]:
    target = Path(path)
    if not target.exists():
        raise FileNotFoundError(f"PLY file does not exist: {target}")

    header_lines: list[str] = []
    header_bytes = 0
    with target.open("rb") as file:
        for raw_line in file:
            header_bytes += len(raw_line)
            line = raw_line.decode("ascii", errors="replace").strip()
            header_lines.append(line)
            if line == "end_header":
                break
        else:
            raise ValueError(f"PLY header is missing end_header: {target}")

    if not header_lines or header_lines[0] != "ply":
        raise ValueError(f"File does not start with a PLY header: {target}")

    ply_format: str | None = None
    vertex_count = 0
    vertex_properties: list[str] = []
    in_vertex = False
    for line in header_lines[1:]:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format" and len(parts) >= 2:
            ply_format = parts[1]
        elif parts[:2] == ["element", "vertex"] and len(parts) >= 3:
            vertex_count = int(parts[2])
            in_vertex = True
        elif parts[0] == "element":
            in_vertex = False
        elif in_vertex and parts[0] == "property" and len(parts) >= 3:
            vertex_properties.append(parts[-1])

    return {
        "format": ply_format,
        "vertex_count": vertex_count,
        "vertex_properties": vertex_properties,
        "is_gaussian_splat": is_gaussian_splat_header(vertex_properties),
        "header_bytes": header_bytes,
        "header_lines": header_lines,
    }


def is_gaussian_splat_header(vertex_properties: list[str]) -> bool:
    props = set(vertex_properties)
    required_groups = [
        {"x", "y", "z"},
        {"opacity"},
        {"scale_0", "scale_1", "scale_2"},
        {"rot_0", "rot_1", "rot_2", "rot_3"},
    ]
    return all(group.issubset(props) for group in required_groups)


def inspect_ply(path: str | Path) -> PlyInfo:
    header = read_ply_header(path)
    points, colors = load_preview_vertices(path)
    bounds_min = points.min(axis=0).tolist()
    bounds_max = points.max(axis=0).tolist()
    return PlyInfo(
        path=str(Path(path)),
        format=header["format"],
        point_count=int(header["vertex_count"]),
        has_colors=bool(colors.size and colors.max(initial=0) > 0),
        vertex_properties=header["vertex_properties"],
        is_gaussian_splat=header["is_gaussian_splat"],
        bounds_min=[float(v) for v in bounds_min],
        bounds_max=[float(v) for v in bounds_max],
    )


def load_preview_vertices(path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    header = read_ply_header(path)
    if header["format"] == "binary_little_endian":
        return _load_binary_little_endian_vertices(Path(path), header)
    if header["format"] == "ascii":
        return _load_ascii_vertices(Path(path), header)
    raise ValueError(f"Unsupported PLY format for preview renderer: {header['format']}")


def _load_binary_little_endian_vertices(
    path: Path, header: dict[str, Any]
) -> tuple[np.ndarray, np.ndarray]:
    dtype = _numpy_vertex_dtype(header["header_lines"])
    with path.open("rb") as file:
        file.seek(header["header_bytes"])
        data = np.fromfile(file, dtype=dtype, count=header["vertex_count"])
    return _extract_points_and_colors(data, header["vertex_properties"])


def _load_ascii_vertices(
    path: Path, header: dict[str, Any]
) -> tuple[np.ndarray, np.ndarray]:
    data = np.loadtxt(path, skiprows=len(header["header_lines"]), dtype=np.float32)
    if data.ndim == 1:
        data = data[None, :]
    columns = {
        name: data[:, index] for index, name in enumerate(header["vertex_properties"])
    }
    return _extract_points_and_colors(columns, header["vertex_properties"])


def _numpy_vertex_dtype(header_lines: list[str]) -> np.dtype:
    dtype_fields: list[tuple[str, str]] = []
    in_vertex = False
    for line in header_lines:
        parts = line.split()
        if parts[:2] == ["element", "vertex"]:
            in_vertex = True
            continue
        if parts and parts[0] == "element":
            in_vertex = False
        if in_vertex and len(parts) >= 3 and parts[0] == "property":
            dtype_fields.append((parts[-1], _ply_scalar_to_numpy(parts[-2])))
    return np.dtype(dtype_fields)


def _ply_scalar_to_numpy(name: str) -> str:
    mapping = {
        "char": "i1",
        "uchar": "u1",
        "int8": "i1",
        "uint8": "u1",
        "short": "<i2",
        "ushort": "<u2",
        "int16": "<i2",
        "uint16": "<u2",
        "int": "<i4",
        "uint": "<u4",
        "int32": "<i4",
        "uint32": "<u4",
        "float": "<f4",
        "float32": "<f4",
        "double": "<f8",
        "float64": "<f8",
    }
    try:
        return mapping[name]
    except KeyError as exc:
        raise ValueError(f"Unsupported PLY scalar type: {name}") from exc


def _extract_points_and_colors(
    data: np.ndarray | dict[str, np.ndarray], properties: list[str]
) -> tuple[np.ndarray, np.ndarray]:
    points = np.column_stack([data["x"], data["y"], data["z"]]).astype(np.float32)
    props = set(properties)
    if {"red", "green", "blue"}.issubset(props):
        colors = np.column_stack([data["red"], data["green"], data["blue"]]).astype(np.float32)
        if colors.max(initial=0) > 1.0:
            colors /= 255.0
    elif {"f_dc_0", "f_dc_1", "f_dc_2"}.issubset(props):
        dc = np.column_stack([data["f_dc_0"], data["f_dc_1"], data["f_dc_2"]]).astype(
            np.float32
        )
        colors = np.clip(dc * 0.28209479177387814 + 0.5, 0.0, 1.0)
    else:
        colors = np.zeros((len(points), 3), dtype=np.float32)
    return points, colors
