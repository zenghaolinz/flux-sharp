from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .base import DummyRepairBackend, ExternalCommandRepairBackend, RepairBackend
from .comfyui_flux import ComfyUIFluxRepairBackend


def create_repair_backend(name: str, config: dict[str, Any] | None = None) -> RepairBackend:
    normalized = name.strip().lower()
    config = config or {}
    if normalized == "dummy":
        return DummyRepairBackend()
    if normalized in {"external", "external-command"}:
        return ExternalCommandRepairBackend(
            command=config.get("command", []),
            working_dir=config.get("working_dir"),
            environment=config.get("environment"),
            timeout_seconds=config.get("timeout_seconds"),
        )
    if normalized in {"comfyui", "comfyui-flux", "flux"}:
        return ComfyUIFluxRepairBackend(
            server_url=config.get("server_url", "http://127.0.0.1:8189"),
            input_dir=config.get("input_dir"),
            output_dir=config.get("output_dir"),
            timeout_seconds=config.get("timeout_seconds", 900),
            poll_seconds=config.get("poll_seconds", 2.0),
            free_memory=config.get("free_memory", True),
            unet_name=config.get("unet_name", "flux-2-klein-9b-Q4_K_M.gguf"),
            clip_name=config.get("clip_name", "qwen_3_8b_fp8mixed.safetensors"),
            vae_name=config.get("vae_name", "flux2-vae.safetensors"),
            lora_name=config.get(
                "lora_name", "flux.2-klein-9B--vggt-splat-render-v1.safetensors"
            ),
            lora_strength=config.get("lora_strength", 1.0),
            steps=config.get("steps", 8),
            cfg=config.get("cfg", 1.0),
            sampler_name=config.get("sampler_name", "euler"),
            seed=config.get("seed"),
        )
    raise ValueError(f"Unsupported repair backend: {name}")


def load_repair_config(path: str | Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


__all__ = [
    "DummyRepairBackend",
    "ComfyUIFluxRepairBackend",
    "ExternalCommandRepairBackend",
    "RepairBackend",
    "create_repair_backend",
    "load_repair_config",
]
