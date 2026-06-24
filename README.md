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

## Browser Preview + Screenshot Repair (default workflow)

The default web UI flow is now browser-side:

```text
photo -> sharp predict (image -> 3DGS .ply) -> WebGL preview (Three.js)
      -> drag to choose angle -> canvas screenshot
      -> ComfyUI FLUX.2 Klein 4B workflow -> repaired output
```

A user uploads a photograph; the backend runs `sharp predict` to regress a 3D
Gaussian Splat `.ply`, loads it into the Three.js preview, and the user orbits
to the desired view. The screenshot is then sent to ComfyUI for repair. The
backend no longer re-renders the PLY from camera parameters; it only saves the
screenshot, patches the workflow's node ids, submits it to ComfyUI, waits over
WebSocket, and downloads the result.

### Image-to-PLY (SHARP)

The photo-to-PLY step uses Apple's [ml-sharp](https://github.com/apple/ml-sharp)
`sharp predict` command, which regresses a 3DGS `.ply` from a single photograph:

```text
sharp predict -i <image> -o <outdir>  ->  <outdir>/<image_stem>.ply
```

Requirements:

- The `.venv-sharp` environment (torch 2.8.0+cu128, gsplat 1.5.3, CUDA).
- The `sharp` CLI on PATH or in `.venv-sharp/Scripts/`. On first run `sharp
  predict` downloads the default checkpoint automatically.
- A CUDA GPU (the runner forces `--device cuda`).

The web UI uploads the photo, queues a background `sharp predict` job, and
polls `/api/sharp/status` until the `.ply` is ready, then loads it into the
preview. One job runs at a time (single GPU).

### ComfyUI monitoring

The web UI polls `http://127.0.0.1:8188/system_stats` and shows a ComfyUI
status dot (green = online, grey = offline). ComfyUI is **not** auto-started;
launch it manually before repairing. The repair client connects to
`127.0.0.1:8188`.

Setup:

1. Place the API-format workflow `FLUX.2+Klein+4B.json` in the project root.
   It must be API-format (keyed by node id), not UI-format (with `nodes`/`links`).
2. Start ComfyUI at `127.0.0.1:8188`.
3. Start this web UI:

   ```bash
   python web_server.py
   ```

4. Open http://127.0.0.1:8765, select a `.ply` from `inputs/`, orbit to the
   desired view, and click "截图并补全".

### Workflow node contract

The client only patches these node ids (never the structure or model names):

| Node | Class type            | Patched input   |
|------|-----------------------|-----------------|
| 76   | LoadImage             | `image`         |
| 126  | CLIPTextEncode        | `text`          |
| 118  | RandomNoise           | `noise_seed`    |
| 125  | Flux2Scheduler        | `steps`         |
| 123  | ImageScaleToTotalPixels | `megapixels`  |
| 9    | SaveImage             | (output source) |

Communication uses the official WebSocket + History pattern: upload via
`/upload/image`, submit via `/prompt`, listen on `/ws` for `executing` with
`node is null`, then fetch `/history/{prompt_id}` and download via `/view`. The
client does not poll ComfyUI's output folder or write to its input folder.

The legacy `/api/run-preview` endpoint and the `src/repair/comfyui_flux.py`
double-image backend are retained for debugging but are no longer exposed in the
UI. Three.js (PLYLoader, OrbitControls) is vendored under `web/vendor/` so the
page works offline.

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
