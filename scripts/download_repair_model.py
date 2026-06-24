from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path

from huggingface_hub import hf_hub_download
from huggingface_hub.utils import HfHubHTTPError, LocalEntryNotFoundError
import requests


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repo_id: str
    filename: str
    license: str
    destination: Path
    notes: str


MODEL_SPECS = {
    "vggt-splat-render": ModelSpec(
        key="vggt-splat-render",
        repo_id="cyburn/vggt-splat-render",
        filename="flux.2-klein-9B--vggt-splat-render-v1.safetensors",
        license="apache-2.0",
        destination=Path("models/vggt"),
        notes="Candidate first repair/enhancement LoRA. Inference contract still needs validation.",
    ),
    "mlsharp-repair-lora": ModelSpec(
        key="mlsharp-repair-lora",
        repo_id="cyrildiagne/flux2-klein9b-lora-mlsharp-3d-repair",
        filename="flux2-klein9b-lora-mlsharp-3d-repair.safetensors",
        license="cc-by-nc-4.0",
        destination=Path("models/loras"),
        notes="Original ml-sharp repair LoRA. Non-commercial license.",
    ),
    "mlsharp-repair-lora-comfy": ModelSpec(
        key="mlsharp-repair-lora-comfy",
        repo_id="siraxe/cyrildiagne_flux2-klein9b-lora-mlsharp-3d-repair",
        filename="flux2-klein9b-lora-mlsharp-3d-repair_comfy.safetensors",
        license="unknown; derived from CC BY-NC 4.0 original",
        destination=Path("models/loras"),
        notes="ComfyUI-prefix variant of the original ml-sharp repair LoRA.",
    ),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Download known repair model files.")
    parser.add_argument("model", choices=sorted(MODEL_SPECS))
    parser.add_argument("--models-dir", default=".", help="Project root for model storage.")
    args = parser.parse_args()

    spec = MODEL_SPECS[args.model]
    root = Path(args.models_dir)
    destination = root / spec.destination
    destination.mkdir(parents=True, exist_ok=True)

    downloaded = download_model_file(spec, destination)

    manifest_path = destination / f"{spec.key}.json"
    manifest = {
        "key": spec.key,
        "repo_id": spec.repo_id,
        "filename": spec.filename,
        "local_path": str(Path(downloaded)),
        "license": spec.license,
        "notes": spec.notes,
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


def download_model_file(spec: ModelSpec, destination: Path) -> Path:
    try:
        return Path(
            hf_hub_download(
                repo_id=spec.repo_id,
                filename=spec.filename,
                local_dir=destination,
            )
        )
    except (HfHubHTTPError, LocalEntryNotFoundError, OSError):
        return download_model_file_via_http(spec, destination)


def download_model_file_via_http(spec: ModelSpec, destination: Path) -> Path:
    url = f"https://huggingface.co/{spec.repo_id}/resolve/main/{spec.filename}"
    target = destination / spec.filename
    temporary = target.with_suffix(target.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with temporary.open("wb") as file:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    file.write(chunk)
    temporary.replace(target)
    return target


if __name__ == "__main__":
    raise SystemExit(main())
