from __future__ import annotations

from pathlib import Path
import json
import shutil
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from .base import RepairBackend


class ComfyUIFluxRepairBackend(RepairBackend):
    name = "comfyui-flux"

    def __init__(
        self,
        server_url: str = "http://127.0.0.1:8189",
        input_dir: str | Path | None = None,
        output_dir: str | Path | None = None,
        timeout_seconds: int = 900,
        poll_seconds: float = 2.0,
        free_memory: bool = True,
        unet_name: str = "flux-2-klein-9b-Q4_K_M.gguf",
        clip_name: str = "qwen_3_8b_fp8mixed.safetensors",
        vae_name: str = "flux2-vae.safetensors",
        lora_name: str = "flux.2-klein-9B--vggt-splat-render-v1.safetensors",
        lora_strength: float = 1.0,
        steps: int = 8,
        cfg: float = 1.0,
        sampler_name: str = "euler",
        seed: int | None = None,
    ) -> None:
        self.server_url = server_url.rstrip("/")
        self.input_dir = Path(input_dir) if input_dir else None
        self.output_dir = Path(output_dir) if output_dir else None
        self.timeout_seconds = timeout_seconds
        self.poll_seconds = poll_seconds
        self.free_memory = free_memory
        self.unet_name = unet_name
        self.clip_name = clip_name
        self.vae_name = vae_name
        self.lora_name = lora_name
        self.lora_strength = lora_strength
        self.steps = steps
        self.cfg = cfg
        self.sampler_name = sampler_name
        self.seed = seed

    def load(self) -> None:
        self._get_json("/system_stats")

    def repair(
        self,
        input_image: str | Path,
        output_path: str | Path,
        reference_image: str | Path | None = None,
        camera_params: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> str:
        if reference_image is None:
            raise ValueError("ComfyUI Flux repair requires a reference image.")
        if self.input_dir is None:
            raise ValueError("ComfyUI Flux repair requires config.input_dir.")

        source = Path(input_image)
        reference = Path(reference_image)
        target = Path(output_path)
        if not source.exists():
            raise FileNotFoundError(f"Input image does not exist: {source}")
        if not reference.exists():
            raise FileNotFoundError(f"Reference image does not exist: {reference}")

        target.parent.mkdir(parents=True, exist_ok=True)
        self.input_dir.mkdir(parents=True, exist_ok=True)
        if self.output_dir:
            self.output_dir.mkdir(parents=True, exist_ok=True)

        raw_name = self._copy_to_input(source, "flux_sharp_raw")
        reference_name = self._copy_to_input(reference, "flux_sharp_reference")
        width, height = _image_size(source)
        width = _align(max(256, min(width, 1536)), 16)
        height = _align(max(256, min(height, 1536)), 16)

        if self.free_memory:
            self._free_memory()

        workflow = self._build_workflow(
            raw_image=raw_name,
            reference_image=reference_name,
            width=width,
            height=height,
            prompt=prompt or "refer to image 2, fix the distortion and blank areas in image 1",
            camera_params=camera_params or {},
        )
        prompt_id = self._queue_prompt(workflow)
        output_file = self._wait_for_output(prompt_id)
        self._copy_output(output_file, target)

        if self.free_memory:
            self._free_memory()
        return str(target)

    def unload(self) -> None:
        if self.free_memory:
            self._free_memory()

    def release_memory(self) -> None:
        if self.free_memory:
            self._free_memory()

    def _copy_to_input(self, path: Path, prefix: str) -> str:
        suffix = path.suffix.lower() if path.suffix else ".png"
        name = f"{prefix}_{uuid4().hex}{suffix}"
        shutil.copyfile(path, self.input_dir / name)
        return name

    def _build_workflow(
        self,
        raw_image: str,
        reference_image: str,
        width: int,
        height: int,
        prompt: str,
        camera_params: dict[str, Any],
    ) -> dict[str, Any]:
        prompt_with_camera = _append_camera_prompt(prompt, camera_params)
        seed = self.seed if self.seed is not None else int(time.time() * 1000) % (2**32)
        return {
            "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": self.unet_name}},
            "2": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": self.clip_name, "type": "flux2", "device": "default"},
            },
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": self.vae_name}},
            "4": {
                "class_type": "LoraLoader",
                "inputs": {
                    "model": ["1", 0],
                    "clip": ["2", 0],
                    "lora_name": self.lora_name,
                    "strength_model": self.lora_strength,
                    "strength_clip": self.lora_strength,
                },
            },
            "5": {
                "class_type": "LoadImage",
                "inputs": {"image": raw_image},
            },
            "6": {
                "class_type": "LoadImage",
                "inputs": {"image": reference_image},
            },
            "7": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["3", 0]}},
            "8": {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["3", 0]}},
            "9": {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": ["4", 1], "text": prompt_with_camera},
            },
            "10": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["9", 0]}},
            "11": {
                "class_type": "ReferenceLatent",
                "inputs": {"conditioning": ["9", 0], "latent": ["7", 0]},
            },
            "12": {
                "class_type": "ReferenceLatent",
                "inputs": {"conditioning": ["11", 0], "latent": ["8", 0]},
            },
            "13": {
                "class_type": "ReferenceLatent",
                "inputs": {"conditioning": ["10", 0], "latent": ["7", 0]},
            },
            "14": {
                "class_type": "ReferenceLatent",
                "inputs": {"conditioning": ["13", 0], "latent": ["8", 0]},
            },
            "15": {
                "class_type": "CFGGuider",
                "inputs": {
                    "model": ["4", 0],
                    "positive": ["12", 0],
                    "negative": ["14", 0],
                    "cfg": self.cfg,
                },
            },
            "16": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
            "17": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": self.sampler_name}},
            "18": {
                "class_type": "Flux2Scheduler",
                "inputs": {"steps": self.steps, "width": width, "height": height},
            },
            "19": {
                "class_type": "EmptyFlux2LatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "20": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {
                    "noise": ["16", 0],
                    "guider": ["15", 0],
                    "sampler": ["17", 0],
                    "sigmas": ["18", 0],
                    "latent_image": ["19", 0],
                },
            },
            "21": {"class_type": "VAEDecode", "inputs": {"samples": ["20", 0], "vae": ["3", 0]}},
            "22": {
                "class_type": "SaveImage",
                "inputs": {"images": ["21", 0], "filename_prefix": "flux_sharp_repair"},
            },
        }

    def _queue_prompt(self, workflow: dict[str, Any]) -> str:
        response = self._post_json(
            "/prompt",
            {"prompt": workflow, "client_id": f"flux-sharp-{uuid4().hex}"},
        )
        errors = response.get("node_errors")
        if errors:
            raise RuntimeError(f"ComfyUI workflow validation failed: {errors}")
        return response["prompt_id"]

    def _wait_for_output(self, prompt_id: str) -> dict[str, str]:
        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            history = self._get_json(f"/history/{prompt_id}")
            if prompt_id in history:
                item = history[prompt_id]
                status = item.get("status", {})
                if status.get("status_str") != "success":
                    raise RuntimeError(f"ComfyUI prompt failed: {status}")
                outputs = item.get("outputs", {})
                for node_output in outputs.values():
                    images = node_output.get("images") or []
                    if images:
                        return images[0]
                raise RuntimeError(f"ComfyUI prompt completed without images: {item}")
            time.sleep(self.poll_seconds)
        raise TimeoutError(f"Timed out waiting for ComfyUI prompt: {prompt_id}")

    def _copy_output(self, image_info: dict[str, str], target: Path) -> None:
        if self.output_dir:
            source = self.output_dir / image_info.get("subfolder", "") / image_info["filename"]
            if source.exists():
                shutil.copyfile(source, target)
                return
        query = urlencode(
            {
                "filename": image_info["filename"],
                "subfolder": image_info.get("subfolder", ""),
                "type": image_info.get("type", "output"),
            }
        )
        data = self._request_bytes(f"/view?{query}")
        target.write_bytes(data)

    def _free_memory(self) -> None:
        try:
            self._post_json("/free", {"unload_models": True, "free_memory": True})
        except Exception:
            pass

    def _get_json(self, path: str) -> dict[str, Any]:
        return json.loads(self._request_bytes(path).decode("utf-8"))

    def _post_json(self, path: str, data: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(data).encode("utf-8")
        req = Request(
            f"{self.server_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI request failed: {exc.code} {detail}") from exc

    def _request_bytes(self, path: str) -> bytes:
        with urlopen(f"{self.server_url}{path}", timeout=30) as response:
            return response.read()


def _image_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def _align(value: int, step: int) -> int:
    return max(step, int(round(value / step) * step))


def _append_camera_prompt(prompt: str, camera_params: dict[str, Any]) -> str:
    if not camera_params:
        return prompt
    yaw = camera_params.get("yaw")
    pitch = camera_params.get("pitch")
    fov = camera_params.get("fov")
    details = []
    if yaw is not None:
        details.append(f"yaw {yaw} degrees")
    if pitch is not None:
        details.append(f"pitch {pitch} degrees")
    if fov is not None:
        details.append(f"field of view {fov} degrees")
    if not details:
        return prompt
    return f"{prompt}. Preserve the rendered camera view ({', '.join(details)})."
