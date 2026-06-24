from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from src.camera import CameraParams
from src.renderers.base import RenderBackend, RenderResult


class SharpCliRenderer(RenderBackend):
    name = "sharp-cli"

    def render(
        self,
        ply_path: str | Path,
        camera: CameraParams,
        output_path: str | Path,
    ) -> RenderResult:
        sharp_executable = _sharp_executable()
        if sharp_executable is None:
            raise RuntimeError(
                "The official sharp CLI is not on PATH. Install apple/ml-sharp and verify `sharp --help`."
            )

        source = Path(ply_path)
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix="sharp-render-") as tmp:
            input_dir = Path(tmp) / "input"
            render_dir = Path(tmp) / "renderings"
            input_dir.mkdir(parents=True, exist_ok=True)
            isolated_source = input_dir / source.name
            shutil.copyfile(source, isolated_source)
            command = [str(sharp_executable), "render", "-i", str(input_dir), "-o", str(render_dir)]
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    "sharp render failed.\n"
                    f"Command: {' '.join(command)}\n"
                    f"stdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}"
                )

            candidates = sorted(
                [
                    *render_dir.rglob("*.png"),
                    *render_dir.rglob("*.jpg"),
                    *render_dir.rglob("*.jpeg"),
                ]
            )
            if candidates:
                shutil.copyfile(candidates[0], output)
            else:
                videos = sorted(render_dir.rglob("*.mp4"))
                color_videos = [video for video in videos if ".depth." not in video.name]
                selected_video = color_videos[0] if color_videos else (videos[0] if videos else None)
                if selected_video is None:
                    raise RuntimeError(
                        f"sharp render completed but no image or video output was found in {render_dir}."
                    )
                _write_first_video_frame(selected_video, output)

            if not output.exists():
                raise RuntimeError(
                    f"sharp render completed but no output image was written to {output}."
                )

        return RenderResult(
            output_path=str(output),
            backend=self.name,
            mode="official-sharp-trajectory",
            notes=[
                "Uses official `sharp render`, which renders SHARP trajectories and requires CUDA.",
                "The current CameraParams are recorded but not mapped to a single exact SHARP camera yet.",
            ],
        )


def _sharp_executable() -> Path | None:
    scripts_dir = Path(sys.executable).parent
    local_sharp = scripts_dir / ("sharp.exe" if sys.platform == "win32" else "sharp")
    if local_sharp.exists():
        return local_sharp
    found = shutil.which("sharp")
    return Path(found) if found else None


def _write_first_video_frame(video_path: Path, output_path: Path) -> None:
    try:
        import imageio.v3 as iio
    except ImportError as exc:
        raise RuntimeError(
            "imageio is required to extract a frame from SHARP mp4 output."
        ) from exc

    frame = iio.imread(video_path, index=0)
    iio.imwrite(output_path, frame)
