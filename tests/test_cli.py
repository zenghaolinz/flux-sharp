from app import build_parser


def test_cli_parses_minimal_args():
    args = build_parser().parse_args(
        ["--ply", "inputs/scene.ply", "--camera", "configs/default_camera.json"]
    )

    assert args.ply == "inputs/scene.ply"
    assert args.backend == "dummy"
    assert args.renderer == "auto"
    assert args.repair_config is None
