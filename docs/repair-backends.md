# Repair Backends

## Current State

The renderer path is now stable enough to start model work. The repair layer has two backend types:

```text
dummy
  Copies render_raw.png to repair_output.png.

external-command
  Runs a configured local command and expects it to write repair_output.png.
```

`external-command` is the bridge for real model scripts. It keeps this app independent from ComfyUI, Diffusers, custom Flux loaders, or any future backend.

## External Command Config

Example:

```json
{
  "command": [
    "python",
    "scripts/example_repair_copy.py",
    "--input",
    "{input_image}",
    "--output",
    "{output_image}"
  ],
  "working_dir": ".",
  "timeout_seconds": 300
}
```

Supported placeholders:

```text
{input_image}
{output_image}
{reference_image}
{prompt}
{camera_json}
```

## vggt-splat-render

Downloaded candidate:

```text
repo: cyburn/vggt-splat-render
file: flux.2-klein-9B--vggt-splat-render-v1.safetensors
license: apache-2.0
local: models/vggt/flux.2-klein-9B--vggt-splat-render-v1.safetensors
```

Model card notes:

```text
prompt: refer to image 2, fix the distortion and blank areas in image 1
image1: vggt splat output
image2: reference image
strength: 1.0 with klein 9B base, or 1.5 with klein 9B Distilled
```

This is currently downloaded weights only. The next implementation step is to choose the inference runtime:

```text
Option A: ComfyUI workflow using Flux.2 Klein 9B + this LoRA
Option B: local Diffusers/custom Flux.2 Klein loader
Option C: another existing Flux image-edit script wrapped by external-command
```

## ml-sharp repair LoRA

Original:

```text
repo: cyrildiagne/flux2-klein9b-lora-mlsharp-3d-repair
license: cc-by-nc-4.0
file: flux2-klein9b-lora-mlsharp-3d-repair.safetensors
```

Comfy prefix variant:

```text
repo: siraxe/cyrildiagne_flux2-klein9b-lora-mlsharp-3d-repair
file: flux2-klein9b-lora-mlsharp-3d-repair_comfy.safetensors
```

The original model card says inference/demo code is not yet provided, so this remains a second candidate until the runtime path is clearer.
