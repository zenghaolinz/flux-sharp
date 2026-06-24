from src.renderers import create_render_backend


def test_create_renderer_backends():
    assert create_render_backend("auto").name == "auto"
    assert create_render_backend("software").name == "software"
    assert create_render_backend("open3d").name == "open3d"
    assert create_render_backend("sharp-cli").name == "sharp-cli"
