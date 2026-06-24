from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
import time
import traceback
from typing import Any

from .camera import CameraParams
from .ply_loader import inspect_ply
from .renderers import RenderBackend, create_render_backend
from .repair.base import RepairBackend


@dataclass(frozen=True)
class PipelineResult:
    run_dir: Path
    render_path: Path
    repair_path: Path
    manifest_path: Path


def _run_name() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def run_pipeline(
    ply_path: str | Path,
    camera: CameraParams,
    repair_backend: RepairBackend,
    output_root: str | Path,
    render_backend: RenderBackend | None = None,
    reference_image: str | Path | None = None,
    prompt: str | None = None,
) -> PipelineResult:
    started = time.perf_counter()
    run_dir = Path(output_root) / _run_name()
    render_path = run_dir / "render_raw.png"
    repair_path = run_dir / "repair_output.png"
    manifest_path = run_dir / "manifest.json"
    log_path = run_dir / "log.txt"
    camera_path = run_dir / "camera_params.json"
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "status": "running",
        "input": {
            "ply_path": str(Path(ply_path)),
            "reference_image": str(reference_image) if reference_image else None,
        },
        "camera": camera.to_dict(),
        "repair_backend": {
            "name": repair_backend.name,
            "prompt": prompt,
        },
        "renderer": {
            "name": render_backend.name if render_backend else "auto",
        },
        "outputs": {
            "render_raw": str(render_path),
            "repair_output": str(repair_path),
            "log": str(log_path),
        },
    }

    logs: list[str] = []
    try:
        _release_repair_memory(repair_backend)
        logs.append("Requested repair backend memory release before rendering.")
        camera.to_json(camera_path)
        ply_info = inspect_ply(ply_path)
        manifest["input"]["ply_info"] = ply_info.to_dict()
        logs.append(f"Loaded PLY with {ply_info.point_count} points.")

        renderer = render_backend or create_render_backend("auto")
        render_result = renderer.render(ply_path, camera, render_path)
        manifest["renderer"] = render_result.to_dict()
        logs.append(f"Rendered raw image to {render_path}.")
        _release_render_memory()
        logs.append("Released renderer-side memory before repair.")

        repair_backend.load()
        try:
            repair_backend.repair(
                input_image=render_path,
                output_path=repair_path,
                reference_image=reference_image,
                camera_params=camera.to_dict(),
                prompt=prompt,
            )
        finally:
            repair_backend.unload()
        logs.append(f"Repair backend '{repair_backend.name}' wrote {repair_path}.")

        manifest["status"] = "success"
    except Exception as exc:
        manifest["status"] = "error"
        manifest["error"] = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
        }
        logs.append(f"ERROR: {type(exc).__name__}: {exc}")
        raise
    finally:
        manifest["duration_seconds"] = round(time.perf_counter() - started, 3)
        log_path.write_text("\n".join(logs) + "\n", encoding="utf-8")
        _write_json(manifest_path, manifest)

    return PipelineResult(
        run_dir=run_dir,
        render_path=render_path,
        repair_path=repair_path,
        manifest_path=manifest_path,
    )


def _release_render_memory() -> None:
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _release_repair_memory(repair_backend: RepairBackend) -> None:
    release = getattr(repair_backend, "release_memory", None)
    if callable(release):
        try:
            release()
        except Exception:
            pass
