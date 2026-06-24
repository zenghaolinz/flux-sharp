# Models

Put local model files here when real repair backends are added.

Suggested future layout:

```text
models/
  flux/
  loras/
  vggt/
```

The MVP does not require model files.

Known repair model downloads:

```bash
python scripts/download_repair_model.py vggt-splat-render
python scripts/download_repair_model.py mlsharp-repair-lora
python scripts/download_repair_model.py mlsharp-repair-lora-comfy
```

`vggt-splat-render` is the preferred first candidate to validate because it is smaller and Apache-2.0. The original ml-sharp repair LoRA is CC BY-NC 4.0 and should remain non-commercial.
