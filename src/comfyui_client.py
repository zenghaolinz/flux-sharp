"""ComfyUI client for the browser-screenshot repair workflow.

This module talks to a local ComfyUI server using the official Server API:
/upload/image, /prompt, /history/{id}, /view, and the /ws WebSocket. It drives
the FLUX.2 Klein 9B API-format workflow (``高斯泼溅修复工作流.json`` in the project
root) by patching specific node ids, never by guessing node names.

Workflow node contract (do not change the structure or model names):

    81  LoadImage               -> inputs.image = rotated screenshot (image 2)
    158 LoadImage               -> inputs.image = original photo (image 1)
    106 CLIPTextEncode          -> inputs.text  = prompt (optional)
    103 RandomNoise             -> inputs.noise_seed = seed (optional)
    99  Flux2Scheduler          -> inputs.steps = steps (optional)
    108 ImageScaleToTotalPixels -> inputs.megapixels = megapixels for image 1 (optional)
    109 ImageScaleToTotalPixels -> inputs.megapixels = megapixels for image 2 (optional)
    94  SaveImage               -> final output image comes from here
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import requests
import websocket


# Workflow node ids that this client is allowed to patch. Anything outside this
# set is left untouched so the workflow structure and model loaders are never
# altered.
REQUIRED_NODES = ("81", "158", "94", "99", "103", "106", "108", "109")
NODE_LOAD_IMAGE_1 = "158"   # original photo (image 1 in prompt)
NODE_LOAD_IMAGE_2 = "81"    # rotated screenshot (image 2 in prompt)
NODE_SAVE_IMAGE = "94"
NODE_RANDOM_NOISE = "103"
NODE_IMAGE_SCALE_1 = "108"  # megapixels for image 1 (node 158 -> 108)
NODE_IMAGE_SCALE_2 = "109"  # megapixels for image 2 (node 81 -> 109)
NODE_FLUX2_SCHEDULER = "99"
NODE_CLIP_TEXT_ENCODE = "106"


class ComfyUIError(RuntimeError):
    """Raised for problems that should be surfaced verbatim to the front-end."""


class ComfyUIClient:
    """Thin client over the ComfyUI HTTP + WebSocket API."""

    def __init__(self, server: str = "127.0.0.1:8188", timeout: int = 60) -> None:
        # Accept both "127.0.0.1:8188" and "http://127.0.0.1:8188".
        bare = server.removeprefix("http://").removeprefix("https://").rstrip("/")
        self.server = bare
        self.base_url = f"http://{bare}"
        self.ws_url = f"ws://{bare}/ws"
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Low-level HTTP helpers
    # ------------------------------------------------------------------
    def _check_running(self) -> None:
        try:
            requests.get(f"{self.base_url}/system_stats", timeout=5)
        except requests.RequestException as exc:
            raise ComfyUIError(
                f"ComfyUI is not running at {self.server}. "
                f"Start it and confirm http://{self.server} responds."
            ) from exc

    def upload_image(self, image_path: Path) -> str:
        url = f"{self.base_url}/upload/image"
        with image_path.open("rb") as handle:
            files = {"image": (image_path.name, handle, "image/png")}
            data = {"type": "input", "overwrite": "true"}
            try:
                res = requests.post(url, files=files, data=data, timeout=self.timeout)
            except requests.RequestException as exc:
                raise ComfyUIError(
                    f"ComfyUI is not running at {self.server}. "
                    f"Start it and confirm http://{self.server} responds."
                ) from exc
        res.raise_for_status()
        payload = res.json()
        name = payload["name"]
        subfolder = payload.get("subfolder") or ""
        return f"{subfolder}/{name}" if subfolder else name

    def queue_prompt(self, workflow: dict[str, Any], client_id: str) -> str:
        url = f"{self.base_url}/prompt"
        payload = {"client_id": client_id, "prompt": workflow}
        try:
            res = requests.post(url, json=payload, timeout=self.timeout)
        except requests.RequestException as exc:
            raise ComfyUIError(
                f"ComfyUI is not running at {self.server}. "
                f"Start it and confirm http://{self.server} responds."
            ) from exc
        res.raise_for_status()
        data = res.json()
        if "error" in data:
            raise ComfyUIError(f"ComfyUI prompt error: {data}")
        node_errors = data.get("node_errors")
        if node_errors:
            raise ComfyUIError(
                f"ComfyUI rejected the workflow (node_errors): "
                f"{json.dumps(node_errors, ensure_ascii=False)}"
            )
        return data["prompt_id"]

    def wait_until_done(self, prompt_id: str, client_id: str) -> None:
        ws_url = f"{self.ws_url}?clientId={client_id}"
        ws = websocket.WebSocket()
        try:
            ws.settimeout(10)
            ws.connect(ws_url)
            ws.settimeout(None)
            while True:
                msg = ws.recv()
                if not isinstance(msg, str):
                    continue
                data = json.loads(msg)
                msg_type = data.get("type")
                payload = data.get("data", {})
                if msg_type == "execution_error":
                    raise ComfyUIError(
                        f"ComfyUI execution error: {json.dumps(data, ensure_ascii=False)}"
                    )
                if msg_type == "executing" and payload.get("prompt_id") == prompt_id:
                    if payload.get("node") is None:
                        return
        finally:
            try:
                ws.close()
            except Exception:
                pass

    def get_history(self, prompt_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/history/{prompt_id}"
        res = requests.get(url, timeout=self.timeout)
        res.raise_for_status()
        return res.json()

    def download_image(
        self,
        filename: str,
        subfolder: str,
        folder_type: str,
        output_path: Path,
    ) -> Path:
        url = f"{self.base_url}/view"
        params = {
            "filename": filename,
            "subfolder": subfolder,
            "type": folder_type,
        }
        res = requests.get(url, params=params, timeout=120)
        res.raise_for_status()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(res.content)
        return output_path

    # ------------------------------------------------------------------
    # High-level workflow driver
    # ------------------------------------------------------------------
    def run_flux2_klein_workflow(
        self,
        workflow_path: Path,
        input_image1_path: Path,
        input_image2_path: Path,
        output_path: Path,
        prompt: str | None = None,
        seed: int | None = None,
        steps: int | None = None,
        megapixels: float | None = None,
    ) -> Path:
        self._check_running()

        workflow = _load_workflow(workflow_path)
        _validate_workflow(workflow)

        # 1. Upload both images to ComfyUI /upload/image.
        uploaded_name1 = self.upload_image(input_image1_path)
        uploaded_name2 = self.upload_image(input_image2_path)

        # 2. Patch only the documented node ids.
        workflow[NODE_LOAD_IMAGE_1]["inputs"]["image"] = uploaded_name1
        workflow[NODE_LOAD_IMAGE_2]["inputs"]["image"] = uploaded_name2
        if prompt is not None:
            workflow[NODE_CLIP_TEXT_ENCODE]["inputs"]["text"] = prompt
        if seed is not None:
            workflow[NODE_RANDOM_NOISE]["inputs"]["noise_seed"] = int(seed)
        if steps is not None:
            workflow[NODE_FLUX2_SCHEDULER]["inputs"]["steps"] = int(steps)
        if megapixels is not None:
            workflow[NODE_IMAGE_SCALE_1]["inputs"]["megapixels"] = float(megapixels)
            workflow[NODE_IMAGE_SCALE_2]["inputs"]["megapixels"] = float(megapixels)

        # 3. Queue the prompt and wait for it to finish via WebSocket.
        client_id = f"flux-sharp-{uuid.uuid4().hex}"
        prompt_id = self.queue_prompt(workflow, client_id)
        self.wait_until_done(prompt_id, client_id)

        # 4. Pull the SaveImage node 9 output from history and download it.
        history = self.get_history(prompt_id)
        if prompt_id not in history:
            raise ComfyUIError(
                f"ComfyUI history has no entry for prompt_id={prompt_id}. "
                f"Available keys: {list(history.keys())}"
            )
        outputs = history[prompt_id].get("outputs", {})
        save_output = outputs.get(NODE_SAVE_IMAGE)
        if not save_output or "images" not in save_output:
            raise ComfyUIError(
                f"No image output found from SaveImage node {NODE_SAVE_IMAGE}. "
                f"prompt_id={prompt_id}, output_keys={list(outputs.keys())}"
            )
        image_info = save_output["images"][0]
        return self.download_image(
            filename=image_info["filename"],
            subfolder=image_info.get("subfolder", ""),
            folder_type=image_info.get("type", "output"),
            output_path=output_path,
        )


def _load_workflow(workflow_path: Path) -> dict[str, Any]:
    if not workflow_path.exists():
        raise ComfyUIError(
            f"Workflow file not found "
            f"(expected at {workflow_path})."
        )
    try:
        data = json.loads(workflow_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ComfyUIError(f"Workflow file is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ComfyUIError("Workflow file is not a JSON object.")
    # A UI-format workflow exposes "nodes" and "links" arrays at the top level;
    # an API-format workflow is keyed by node id strings. Refuse UI format so we
    # never try to blindly convert it.
    if "nodes" in data and "links" in data:
        raise ComfyUIError(
            "Workflow file is a UI-format workflow (has 'nodes'/'links'), "
            "not an API-format workflow. Export the API-format JSON from ComfyUI."
        )
    return data


def _validate_workflow(workflow: dict[str, Any]) -> None:
    missing = [node for node in REQUIRED_NODES if node not in workflow]
    if missing:
        raise ComfyUIError(
            f"Workflow is missing required node ids: {missing}. "
            f"Expected nodes: {list(REQUIRED_NODES)}."
        )
    for node in REQUIRED_NODES:
        if not isinstance(workflow[node], dict) or "inputs" not in workflow[node]:
            raise ComfyUIError(
                f"Workflow node '{node}' is malformed (missing 'inputs')."
            )
