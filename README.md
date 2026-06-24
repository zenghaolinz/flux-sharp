# MLSharp Flux Repair MVP

Lightweight MVP for a local `ml-sharp` / 3DGS view-rendering and image-repair pipeline.

The first milestone intentionally stays small:

```text
PLY -> renderer backend -> raw PNG render -> repair backend interface -> output manifest
```

## Current Scope

- Load ordinary PLY files with Open3D.
- Inspect PLY headers and flag likely 3DGS files by Gaussian properties.
- Store and validate camera parameters in JSON.
- Render a PLY from a requested camera view with a selectable renderer backend.
- Run a pluggable repair backend.
- Ship a `dummy` repair backend that copies the raw render so the pipeline can be verified before model work begins.
- Write a per-run output directory with render, repair result, logs, and `manifest.json`.

Open3D and the software renderer are preview paths only. They may treat SHARP/3DGS `.ply` files as ordinary point clouds, so final image quality should be evaluated with a real 3D Gaussian Splatting renderer.

## Install

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run

```bash
python app.py --ply inputs/scene.ply --camera configs/default_camera.json --backend dummy --renderer auto --output outputs
```

The command creates a timestamped run directory under `outputs/`.

Renderer options:

```text
auto       Uses Open3D where practical, otherwise falls back to software preview.
software   Pure Python/Pillow point-cloud projection; useful for Windows/headless smoke tests.
open3d     Open3D OffscreenRenderer point-cloud preview.
sharp-cli  Official apple/ml-sharp CLI validation path; requires `sharp` on PATH and CUDA for rendering.
```

The official SHARP project says its `.ply` outputs are 3D Gaussian Splats, use the OpenCV convention `(x right, y down, z forward)`, and can be rendered through `sharp render` with CUDA.

On Windows, run official SHARP/CUDA commands through:

```bash
scripts\run_with_vsdevcmd.bat .venv-sharp\Scripts\python.exe app.py --ply inputs\scene.ply --renderer sharp-cli --backend dummy
```

The `.venv-sharp` environment is the dedicated official-renderer environment. It should use `torch==2.8.0+cu128`, `torchvision==0.23.0+cu128`, and `gsplat==1.5.3`.

## Local Web UI

Start the camera-planning UI with:

```bash
python web_server.py
```

Then open:

```text
http://127.0.0.1:8765
```

The first web milestone supports:

- Uploading a reference image into a local session under `web_uploads/`.
- Selecting an existing PLY from `inputs/`.
- Adjusting a camera-style orbit control for yaw, pitch, roll, distance, FOV, and output size.
- Exporting the structured `CameraParams` JSON.
- Running a preview render through the existing pipeline.
- Sending the raw render and uploaded reference image to the ComfyUI Flux repair backend.

Image-to-PLY generation is intentionally represented as a pipeline step in the UI, but is not wired into the web endpoint yet.

The ComfyUI repair backend calls ComfyUI's `/free` endpoint before and after repair. The pipeline also asks the repair backend to release memory before rendering, then runs local CUDA/GC cleanup after rendering before submitting repair work. This keeps the SHARP render and Flux repair stages from holding VRAM at the same time.

## Project Layout

```text
app.py
configs/
inputs/
models/
outputs/
src/
tests/
```

## Next Milestones

1. Validate SHARP-generated `.ply` files against Open3D and a true 3DGS renderer.
2. Map `CameraParams` to SHARP/OpenCV camera conventions for exact single-view rendering.
3. Add a spike for `vggt-splat-render`: repository, license, input/output contract, VRAM needs.
4. Add a Flux/LoRA repair backend after confirming loading mechanics and license constraints.
5. Add batch camera generation and a small evaluation set.

Repair backend notes live in [docs/repair-backends.md](docs/repair-backends.md).
