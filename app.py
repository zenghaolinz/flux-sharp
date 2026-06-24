from __future__ import annotations

import argparse
from pathlib import Path

from src.camera import CameraParams
from src.pipeline import run_pipeline
from src.renderers import create_render_backend
from src.repair import create_repair_backend, load_repair_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render an ml-sharp/PLY scene and run a repair backend."
    )
    parser.add_argument("--ply", required=True, help="Path to the input PLY file.")
    parser.add_argument(
        "--camera",
        default="configs/default_camera.json",
        help="Path to a camera JSON config.",
    )
    parser.add_argument(
        "--backend",
        default="dummy",
        choices=["dummy", "external-command", "comfyui-flux"],
        help="Repair backend to run.",
    )
    parser.add_argument(
        "--repair-config",
        default=None,
        help="Optional JSON config for the selected repair backend.",
    )
    parser.add_argument(
        "--renderer",
        default="auto",
        choices=["auto", "software", "open3d", "sharp-cli"],
        help="Renderer backend to use for raw image generation.",
    )
    parser.add_argument(
        "--output",
        default="outputs",
        help="Directory where timestamped run outputs are written.",
    )
    parser.add_argument(
        "--reference",
        default=None,
        help="Optional reference image for future repair backends.",
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Optional prompt for future repair backends.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    camera = CameraParams.from_json(args.camera)
    repair_config = load_repair_config(args.repair_config)
    backend = create_repair_backend(args.backend, repair_config)
    renderer = create_render_backend(args.renderer)

    result = run_pipeline(
        ply_path=Path(args.ply),
        camera=camera,
        repair_backend=backend,
        render_backend=renderer,
        output_root=Path(args.output),
        reference_image=Path(args.reference) if args.reference else None,
        prompt=args.prompt,
    )
    print(f"Run complete: {result.run_dir}")
    print(f"Raw render:   {result.render_path}")
    print(f"Repair:       {result.repair_path}")
    print(f"Manifest:     {result.manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
