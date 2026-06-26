# Flux Sharp

English | [中文](README.md)

Local single-photo → 3D Gaussian Splat → view-repair pipeline with a browser UI.

Upload a photograph, regress a 3DGS `.ply` with Apple's [ml-sharp](https://github.com/apple/ml-sharp),
orbit to the view you want in a WebGL preview, then send that raw 3DGS screenshot
plus the original photo to a ComfyUI FLUX.2 Klein 9B workflow for hole-filling
reconstruction.

```text
photo ──sharp predict──▶ 3DGS .ply ──WebGL orbit──▶ raw screenshot
   │                                                    │
   └────────────────────► ComfyUI FLUX.2 Klein ◀───────┘
                          (original + screenshot, dual-image repair) ──▶ repaired image
```

The 3D preview, repair trigger, and gallery all live in the browser. The Python
backend only runs `sharp predict`, brokers the ComfyUI call, and serves files.

## Overview

A single-image 3D Gaussian Splatting view-repainting tool built on Flux2Klein,
the `siraxe/cyrildiagne_flux2-klein9b-lora-mlsharp-3d-repair` LoRA, and
Apple ML-SHARP.

Apple ML-SHARP turns a single input photo into a 3DGS preview. You can orbit,
zoom, and pick a new viewing angle in the browser, then Flux2Klein together with
a dedicated 3D repair LoRA reconstructs, repairs, and completes the current 3DGS
render. This addresses the holes, stretching, object distortion, architectural
warping, face deformation, and background loss that Gaussian splatting produces
when the viewpoint changes.


## Quick start (Windows)

```bat
start.bat
```

`start.bat` uses the bundled `.venv-sharp` interpreter and starts the web UI at
<http://127.0.0.1:8765>. Press `Ctrl+C` in the console to stop.

### Manual start

```bash
python web_server.py          # serves http://127.0.0.1:8765
```

### Services you need running

| Service | Address | Started by |
|---------|---------|------------|
| Flux Sharp web UI | `127.0.0.1:8765` | `web_server.py` (this project) |
| ComfyUI | `127.0.0.1:8188` | **manually** — not auto-started |
| `sharp` CLI | on PATH or in `.venv-sharp/Scripts/` | bundled env |

The web UI shows live status dots for the API and ComfyUI. ComfyUI must be
online before clicking **重构** (repair); `sharp predict` runs on demand when you
click **生成** (generate).

## Environment

The project ships a dedicated virtual environment at `.venv-sharp/` for the
SHARP / CUDA stack:

- `torch==2.8.0+cu128`, `torchvision==0.23.0+cu128`, `gsplat==1.5.3`
- The `sharp` CLI (first `sharp predict` run downloads the default checkpoint)
- A CUDA GPU — the runner forces `--device cuda`

Web/backend deps are in `requirements.txt` (`numpy`, `open3d`, `Pillow`,
`requests`, `websocket-client`, `huggingface-hub`, `pytest`). Install into the
same interpreter the web UI runs on:

```bash
.venv-sharp\Scripts\python.exe -m pip install -r requirements.txt
```

## How it works

### 1. Upload → gallery

Photos are uploaded to `/api/gallery/import`, stored under `web_uploads/gallery/`,
and tracked in `web_uploads/gallery/gallery.json`. The gallery **stores originals
only** — 3DGS `.ply` files, screenshots, and repair results are workflow state
kept in memory and are not persisted. Duplicate uploads are allowed; each keeps
its own entry.

### 2. Generate — SHARP image → 3DGS PLY

Clicking **生成** queues a background `sharp predict` job (`src/sharp_runner.py`):

```text
sharp predict -i <photo> -o <outdir> --device cuda  ->  <outdir>/<stem>.ply
```

One job runs at a time (single GPU). The UI polls `/api/sharp/status` until the
`.ply` is ready, then loads it into the GaussianSplats3D viewer.

### 3. Orbit → screenshot

The PLY is rendered in-browser with the vendored `GaussianSplats3D` library
(Three.js). Orbit controls are damped and slowed so you can pick a precise view.
A photo→3DGS cross-fade plays on load to avoid a black frame.

### 4. Repair — ComfyUI dual-image repair

Clicking **重构** captures the **raw** 3DGS render target (before any UI
feathering) plus the original photo, and submits both to ComfyUI. Repair locks
the preview so the screenshot matches the visible camera at click time.

The client (`src/comfyui_client.py`) loads the API-format workflow at the
project root — **`高斯泼溅修复工作流.json`** — patches only input fields
(never structure or model loaders), and uses the official WebSocket + History
flow: `/upload/image` → `/prompt` → listen on `/ws` for `executing` with
`node is null` → `/history/{prompt_id}` → `/view`.

#### Workflow node contract

| Node | Class type            | Patched input        |
|------|-----------------------|----------------------|
| 81   | LoadImage             | `image` (screenshot) |
| 158  | LoadImage             | `image` (original photo) |
| 106  | CLIPTextEncode        | `text` (prompt)      |
| 103  | RandomNoise           | `noise_seed`         |
| 99   | Flux2Scheduler        | `steps`              |
| 108  | ImageScaleToTotalPixels | `megapixels` (image 1) |
| 109  | ImageScaleToTotalPixels | `megapixels` (image 2) |
| 94   | SaveImage             | (output source)      |

The repair prompt is built from the camera movement delta between the initial
view and the chosen view (see `buildRepairPrompt` / `computeCameraMove` in
`web/app.js`).

## HTTP API

Served by `web_server.py` on `127.0.0.1:8765`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Backend liveness |
| `/api/comfyui-status` | GET | ComfyUI online check (`127.0.0.1:8188/system_stats`) |
| `/api/gallery` | GET | List gallery items (originals only, newest first) |
| `/api/gallery/import` | POST | Upload a new original (SHA-256 hashed, dedup-allowed) |
| `/api/gallery/upsert` | POST | Backward-compatible upsert (originals only) |
| `/api/gallery/update` | POST | Update an item's metadata |
| `/api/sharp/generate` | POST | Queue a `sharp predict` job for an item |
| `/api/sharp/status` | GET | Poll the running SHARP job |
| `/api/sharp/ply` | GET | Fetch the generated `.ply` for an item |
| `/api/ply-vertex-only` | GET | Stream a vertex-only PLY for the viewer |
| `/api/ply-camera` | GET | Read camera params from a PLY |
| `/api/ply-files` | GET | List PLYs under `inputs/` |
| `/api/repair-screenshot` | POST | Submit original + screenshot to ComfyUI, return repaired image |
| `/api/sessions` | POST | Create an upload session dir |
| `/api/export-camera` | POST | Export `CameraParams` JSON |
| `/api/run-preview` | POST | Legacy server-side render (retained for debugging, not in UI) |
| `/api/file` | GET | Generic static file passthrough |

## Project layout

```text
web_server.py              Web UI + API server (entry point)
start.bat                  One-click launcher (.venv-sharp)
src/
  sharp_runner.py          Background `sharp predict` runner (singleton, 1 GPU job)
  comfyui_client.py        ComfyUI WebSocket client + dual-image workflow driver
  pipeline.py              Legacy render/repair pipeline (CLI path)
  camera.py, ply_loader.py, renderer.py, renderers/   Renderer backends
  repair/                  Repair backends (comfyui_flux.py legacy single-image)
web/
  app.js, index.html, style.css   Browser UI (GaussianSplats3D + Three.js)
  vendor/                  Vendored three.module.js, PLYLoader, OrbitControls,
                           gaussian-splats-3d.module.js (offline-capable)
configs/                   Camera + repair configs (default_camera.json, repair_config.json, …)
scripts/                   kill_port.ps1, probe_ply_camera.py, run_with_vsdevcmd.bat, …
高斯泼溅修复工作流.json      ComfyUI API-format workflow (dual-image FLUX.2 Klein 9B)
docs/                      renderer-spike.md, repair-backends.md
models/                    VGGT splat-render config
inputs/  outputs/  web_uploads/   Runtime data (gallery originals under web_uploads/gallery/)
```

## CLI (legacy)

`app.py` is the original CLI pipeline (`--ply`, `--camera`, `--renderer`,
`--backend`). It is retained for renderer/repair debugging and smoke tests but is
not the main flow — the web UI is. Renderer backends: `auto`, `software`
(Pillow projection), `open3d` (point-cloud preview), `sharp-cli` (official
ml-sharp, CUDA). See `docs/renderer-spike.md`.

```bash
scripts\run_with_vsdevcmd.bat .venv-sharp\Scripts\python.exe app.py \
  --ply inputs/scene.ply --renderer sharp-cli --backend dummy
```

## Notes

- The browser receives the **raw** 3DGS screenshot (with black holes / sparse
  regions), matching the LoRA repair training domain. The user-facing preview may
  be visually softened, but ComfyUI always gets the raw render.
- The repair client calls ComfyUI's `/free` before and after repair so the SHARP
  stage and the Flux repair stage don't hold VRAM simultaneously.
- Three.js, PLYLoader, OrbitControls, and GaussianSplats3D are vendored under
  `web/vendor/` so the page works fully offline.
