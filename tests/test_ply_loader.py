from pathlib import Path

from src.ply_loader import is_gaussian_splat_header, read_ply_header


def test_read_ply_header_detects_basic_point_cloud(tmp_path: Path):
    path = tmp_path / "points.ply"
    path.write_text(
        "\n".join(
            [
                "ply",
                "format ascii 1.0",
                "element vertex 1",
                "property float x",
                "property float y",
                "property float z",
                "end_header",
                "0 0 0",
            ]
        ),
        encoding="ascii",
    )

    header = read_ply_header(path)

    assert header["format"] == "ascii"
    assert header["vertex_count"] == 1
    assert header["vertex_properties"] == ["x", "y", "z"]
    assert header["is_gaussian_splat"] is False


def test_gaussian_splat_header_detection():
    props = [
        "x",
        "y",
        "z",
        "opacity",
        "scale_0",
        "scale_1",
        "scale_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ]

    assert is_gaussian_splat_header(props)
