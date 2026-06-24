from pathlib import Path

import pytest

from src.ply_loader import load_preview_vertices


def test_load_preview_vertices_uses_f_dc_colors(tmp_path: Path):
    path = tmp_path / "sharp_like.ply"
    path.write_text(
        "\n".join(
            [
                "ply",
                "format ascii 1.0",
                "element vertex 1",
                "property float x",
                "property float y",
                "property float z",
                "property float f_dc_0",
                "property float f_dc_1",
                "property float f_dc_2",
                "property float opacity",
                "property float scale_0",
                "property float scale_1",
                "property float scale_2",
                "property float rot_0",
                "property float rot_1",
                "property float rot_2",
                "property float rot_3",
                "end_header",
                "1 2 3 0 0 0 1 0 0 0 1 0 0 0",
            ]
        ),
        encoding="ascii",
    )

    points, colors = load_preview_vertices(path)

    assert points.tolist() == [[1, 2, 3]]
    assert colors[0, 0] == pytest.approx(0.5)
    assert colors[0, 1] == pytest.approx(0.5)
    assert colors[0, 2] == pytest.approx(0.5)
