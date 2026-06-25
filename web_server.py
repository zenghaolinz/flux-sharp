from __future__ import annotations

import base64
import json
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse
from uuid import uuid4

from src.camera import CameraParams
from src.comfyui_client import ComfyUIClient, ComfyUIError
from src.pipeline import run_pipeline
from src.renderers import create_render_backend
from src.repair import create_repair_backend, load_repair_config
from src.sharp_runner import SharpRunner


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
UPLOAD_ROOT = ROOT / "web_uploads"
OUTPUT_ROOT = ROOT / "outputs"
INPUT_ROOT = ROOT / "inputs"

# Shared SharpRunner singleton: one background worker for sharp predict jobs.
# Generated PLYs are copied into INPUT_ROOT so the PLY dropdown picks them up.
SHARP_RUNNER = SharpRunner(output_root=OUTPUT_ROOT, inputs_root=INPUT_ROOT)
COMFYUI_SERVER = "127.0.0.1:8188"
MANIFEST_PATH = UPLOAD_ROOT / "manifest.json"
_PLY_HASH_RE = re.compile(r"^(.+?)_([0-9a-f]{8})\.ply$")


def _load_manifest() -> dict[str, str]:
    """Load photo-base-name → PLY-relative-path manifest."""
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {}


def _save_manifest(manifest: dict[str, str]) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))


def _ply_base_name(ply_name: str) -> str:
    """Extract base photo name from a PLY filename (strip trailing _{8hex})."""
    m = _PLY_HASH_RE.match(ply_name)
    return m.group(1) if m else Path(ply_name).stem


def _find_cached_ply(image_name: str) -> Path | None:
    """If a PLY already exists for this photo, return its absolute path."""
    stem = Path(image_name).stem
    manifest = _load_manifest()
    rel = manifest.get(stem)
    if rel:
        abs_path = ROOT / rel
        if abs_path.exists():
            return abs_path
    return None


def _comfyui_online() -> bool:
    """Probe ComfyUI /system_stats with a short timeout. Never raises."""
    try:
        import requests

        res = requests.get(f"http://{COMFYUI_SERVER}/system_stats", timeout=3)
        return res.status_code == 200
    except Exception:
        return False


def _json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def _safe_workspace_path(path: str | Path) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve()
    if ROOT != resolved and ROOT not in resolved.parents:
        raise ValueError(f"Path is outside workspace: {resolved}")
    return resolved


def _available_ply_files() -> list[dict[str, Any]]:
    files = list((ROOT / "inputs").glob("*.ply"))
    # Sort newest-first so a freshly generated PLY appears at the top and the
    # front-end auto-loads it without extra logic.
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "name": path.name,
            "path": str(path),
            "size_bytes": path.stat().st_size,
        }
        for path in files
    ]


def _decode_upload(data_url: str) -> tuple[bytes, str]:
    header, _, payload = data_url.partition(",")
    if not payload:
        raise ValueError("Expected a data URL payload.")
    if ";base64" not in header:
        raise ValueError("Only base64 data URLs are supported.")
    mime = header.removeprefix("data:").split(";", 1)[0] or "application/octet-stream"
    return base64.b64decode(payload), mime


def _extension_for_mime(mime_type: str, fallback_name: str) -> str:
    ext = Path(fallback_name).suffix.lower()
    if ext in {".png", ".jpg", ".jpeg", ".webp"}:
        return ext
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(mime_type, ".png")


def _strip_ply_to_vertex_only(data: bytes) -> bytes:
    """Return a PLY containing only the `vertex` element.

    SHARP PLYs append extrinsic/intrinsic/image_size/frame/disparity/color_space/
    version elements after the vertex block. Some 3DGS renderers (e.g.
    GaussianSplats3D) reject those as "unsupported format", so we strip them:
    keep only `element vertex ...` properties + that element's binary body.
    """
    # Find the header end ("end_header\n").
    sep = data.find(b"end_header")
    if sep == -1:
        return data
    line_end = data.find(b"\n", sep)
    if line_end == -1:
        line_end = len(data)
    header_text = data[: line_end + 1].decode("ascii", errors="replace")

    header_lines = header_text.splitlines()
    out_header = ["ply"]
    vertex_count = 0
    in_vertex = False
    vertex_props = []
    for line in header_lines[1:]:  # skip leading "ply"
        if line.startswith("format "):
            out_header.append(line)
        elif line.startswith("comment "):
            out_header.append(line)
        elif line.startswith("element vertex "):
            in_vertex = True
            vertex_count = int(line.split()[2])
            out_header.append(line)
        elif line.startswith("element "):
            in_vertex = False  # stop at the first non-vertex element
        elif line.startswith("property ") and in_vertex:
            out_header.append(line)
    out_header.append("end_header")
    new_header = "\n".join(out_header) + "\n"

    # Determine bytes-per-vertex from the vertex properties (all float32 in
    # SHARP output). Each "property float X" = 4 bytes; uint = 4; uchar = 1.
    prop_size = {"float": 4, "double": 8, "uint": 4, "int": 4, "uchar": 1,
                 "ushort": 2, "short": 2}
    bytes_per_vertex = 0
    for line in header_lines:
        if line.startswith("property ") and (vertex_props or in_vertex):
            parts = line.split()
            if len(parts) >= 3:
                bytes_per_vertex += prop_size.get(parts[1], 4)
        if line.startswith("element ") and not line.startswith("element vertex"):
            break
    # Recompute properly: only count vertex properties.
    bytes_per_vertex = 0
    seen_vertex = False
    for line in header_lines:
        if line.startswith("element vertex "):
            seen_vertex = True
        elif line.startswith("element "):
            seen_vertex = False
        elif line.startswith("property ") and seen_vertex:
            parts = line.split()
            bytes_per_vertex += prop_size.get(parts[1], 4) if len(parts) >= 3 else 4

    body_start = line_end + 1
    vertex_body = data[body_start: body_start + vertex_count * bytes_per_vertex]
    return new_header.encode("ascii") + vertex_body


class FluxSharpHandler(BaseHTTPRequestHandler):
    server_version = "FluxSharpWeb/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/":
                self._serve_static(WEB_ROOT / "index.html")
            elif parsed.path.startswith("/web/"):
                self._serve_static(WEB_ROOT / parsed.path.removeprefix("/web/"))
            elif parsed.path == "/api/health":
                self._send_json({"status": "ok", "root": str(ROOT)})
            elif parsed.path == "/api/ply-files":
                self._send_json({"files": _available_ply_files()})
            elif parsed.path == "/api/file":
                query = parse_qs(parsed.query)
                target = _safe_workspace_path(query.get("path", [""])[0])
                self._serve_static(target)
            elif parsed.path == "/api/ply-vertex-only":
                query = parse_qs(parsed.query)
                target = _safe_workspace_path(query.get("path", [""])[0])
                self._serve_vertex_only_ply(target)
            elif parsed.path == "/api/comfyui-status":
                self._send_json(
                    {"online": _comfyui_online(), "server": COMFYUI_SERVER}
                )
            elif parsed.path == "/api/sharp/status":
                self._sharp_status(parsed)
            elif parsed.path == "/api/sharp/ply":
                self._sharp_ply(parsed)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._send_error(exc)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json()
            if parsed.path == "/api/sessions":
                self._create_session(payload)
            elif parsed.path == "/api/export-camera":
                self._export_camera(payload)
            elif parsed.path == "/api/run-preview":
                self._run_preview(payload)
            elif parsed.path == "/api/repair-screenshot":
                self._repair_screenshot(payload)
            elif parsed.path == "/api/sharp/generate":
                self._sharp_generate(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._send_error(exc)

    def _create_session(self, payload: dict[str, Any]) -> None:
        session_id = uuid4().hex
        session_dir = UPLOAD_ROOT / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        image_data = payload.get("imageData")
        image_name = payload.get("imageName") or "reference.png"
        reference_path = None
        if image_data:
            raw, mime_type = _decode_upload(image_data)
            suffix = _extension_for_mime(mime_type, image_name)
            reference_path = session_dir / f"reference{suffix}"
            reference_path.write_bytes(raw)

        camera = CameraParams().to_dict()
        camera_path = session_dir / "camera.json"
        CameraParams.from_dict(camera).to_json(camera_path)

        self._send_json(
            {
                "session_id": session_id,
                "reference_image": str(reference_path) if reference_path else None,
                "camera_path": str(camera_path),
                "camera": camera,
                "ply_files": _available_ply_files(),
            }
        )

    def _export_camera(self, payload: dict[str, Any]) -> None:
        session_id = payload["session_id"]
        camera = CameraParams.from_dict(payload["camera"])
        session_dir = _safe_workspace_path(UPLOAD_ROOT / session_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        camera_path = session_dir / "camera.json"
        camera.to_json(camera_path)
        self._send_json({"camera_path": str(camera_path), "camera": camera.to_dict()})

    def _run_preview(self, payload: dict[str, Any]) -> None:
        camera = CameraParams.from_dict(payload["camera"])
        ply_path = _safe_workspace_path(payload["ply_path"])
        if not ply_path.exists():
            raise FileNotFoundError(f"PLY not found: {ply_path}")

        renderer_name = payload.get("renderer") or "software"
        repair_name = payload.get("repair_backend") or "dummy"
        repair_config = {}
        if repair_name == "comfyui-flux":
            repair_config = load_repair_config(ROOT / "configs" / "comfyui_flux_repair.json")
        result = run_pipeline(
            ply_path=ply_path,
            camera=camera,
            repair_backend=create_repair_backend(repair_name, repair_config),
            render_backend=create_render_backend(renderer_name),
            output_root=OUTPUT_ROOT,
            reference_image=payload.get("reference_image"),
            prompt=payload.get("prompt"),
        )
        self._send_json(
            {
                "run_dir": str(result.run_dir),
                "render_path": str(result.render_path),
                "repair_path": str(result.repair_path),
                "manifest_path": str(result.manifest_path),
                "render_url": f"/api/file?path={quote(str(result.render_path))}",
                "repair_url": f"/api/file?path={quote(str(result.repair_path))}",
                "manifest_url": f"/api/file?path={quote(str(result.manifest_path))}",
            }
        )

    def _repair_screenshot(self, payload: dict[str, Any]) -> None:
        # Browser-preview workflow: the front-end sends a canvas screenshot of
        # the current Three.js view; we save it, upload it to ComfyUI, drive the
        # FLUX.2 Klein workflow, and return the repaired image URL.
        if "screenshot" not in payload:
            raise ValueError("Missing 'screenshot' data URL in request body.")

        session_id = payload.get("session_id") or uuid4().hex
        run_dir = OUTPUT_ROOT / f"browser_{session_id}"
        run_dir.mkdir(parents=True, exist_ok=True)

        raw, _mime = _decode_upload(payload["screenshot"])
        screenshot_path = run_dir / "browser_view.png"
        screenshot_path.write_bytes(raw)

        repair_path = run_dir / "repair_output.png"
        workflow_path = ROOT / "FLUX.2+Klein+4B (1).json"

        client = ComfyUIClient(server="127.0.0.1:8188")
        client.run_flux2_klein_workflow(
            workflow_path=workflow_path,
            input_image_path=screenshot_path,
            output_path=repair_path,
            prompt=payload.get("prompt"),
            seed=payload.get("seed"),
            steps=payload.get("steps"),
            megapixels=payload.get("megapixels"),
        )

        self._send_json(
            {
                "session_id": session_id,
                "screenshot_path": str(screenshot_path),
                "repair_path": str(repair_path),
                "screenshot_url": f"/api/file?path={quote(str(screenshot_path))}",
                "repair_url": f"/api/file?path={quote(str(repair_path))}",
            }
        )

    def _sharp_generate(self, payload: dict[str, Any]) -> None:
        # Accept an uploaded photo and queue a `sharp predict` job that turns it
        # into a 3DGS .ply. Returns immediately with a job_id; the front-end
        # polls /api/sharp/status.
        image_data = payload.get("imageData")
        if not image_data:
            raise ValueError("Missing 'imageData' data URL in request body.")
        image_name = payload.get("imageName") or "upload.png"

        # ─ Cache hit: PLY already exists for this photo → skip SHARP. ──
        cached_ply = _find_cached_ply(image_name)
        if cached_ply:
            job_id = uuid4().hex
            # Register a completed fake job so pollSharpDone resolves immediately.
            SHARP_RUNNER._jobs[job_id] = type(
                "_CachedJob", (), {
                    "job_id": job_id,
                    "image_path": Path(image_name),
                    "output_dir": OUTPUT_ROOT,
                    "state": "done",
                    "ply_path": cached_ply,
                    "error": None,
                    "log": "[cache] PLY already exists — skipped SHARP.",
                    "_lock": __import__("threading").Lock(),
                    "snapshot": lambda self: {
                        "job_id": self.job_id, "state": self.state,
                        "image_path": str(self.image_path),
                        "ply_path": str(self.ply_path),
                        "error": self.error, "log": self.log,
                    },
                }
            )()
            self._send_json({
                "job_id": job_id,
                "state": "done",
                "ply_path": str(cached_ply),
                "ply_url": f"/api/file?path={quote(str(cached_ply))}",
                "cached": True,
            })
            return

        # ─ Cache miss: run SHARP. ─
        if not SHARP_RUNNER.sharp_available():
            raise RuntimeError(
                "sharp CLI not found. Install apple/ml-sharp into .venv-sharp "
                "or put `sharp` on PATH."
            )

        raw, mime_type = _decode_upload(image_data)
        suffix = _extension_for_mime(mime_type, image_name)
        job_staging = OUTPUT_ROOT / "sharp_staging"
        job_staging.mkdir(parents=True, exist_ok=True)
        stem = Path(image_name).stem or "upload"
        image_path = job_staging / f"{stem}_{uuid4().hex[:8]}{suffix}"
        image_path.write_bytes(raw)

        job = SHARP_RUNNER.submit(image_path)
        self._send_json(
            {
                "job_id": job.job_id,
                "image_path": str(image_path),
                "image_url": f"/api/file?path={quote(str(image_path))}",
                "state": job.snapshot()["state"],
            }
        )

    def _sharp_status(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        job_id = query.get("job_id", [""])[0]
        status = SHARP_RUNNER.get_status(job_id)
        if status is None:
            raise ValueError(f"Unknown sharp job_id: {job_id}")
        ply_path = status.get("ply_path")
        if ply_path:
            status["ply_url"] = f"/api/file?path={quote(str(ply_path))}"

        # When a new PLY is generated, update the manifest so future uploads
        # of the same photo can skip SHARP.
        if status.get("state") == "done" and ply_path and not status.get("_cached"):
            image_path_str = status.get("image_path", "")
            if image_path_str:
                base_name = _ply_base_name(Path(image_path_str).name)
                manifest = _load_manifest()
                manifest[base_name] = str(Path(ply_path).relative_to(ROOT))
                _save_manifest(manifest)

        status["sharp_available"] = SHARP_RUNNER.sharp_available()
        self._send_json(status)

    def _sharp_ply(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        job_id = query.get("job_id", [""])[0]
        status = SHARP_RUNNER.get_status(job_id)
        if status is None:
            raise ValueError(f"Unknown sharp job_id: {job_id}")
        if status["state"] != "done" or not status.get("ply_path"):
            raise RuntimeError(
                f"PLY not ready for job {job_id} (state={status['state']})."
            )
        ply_url = f"/api/file?path={quote(str(status['ply_path']))}"
        self._send_json(
            {"job_id": job_id, "ply_path": status["ply_path"], "ply_url": ply_url}
        )

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        data = self.rfile.read(length)
        return json.loads(data.decode("utf-8")) if data else {}

    def _serve_static(self, path: Path) -> None:
        target = path.resolve()
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        mime = _mime_type(target)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()
        self.wfile.write(target.read_bytes())

    def _serve_vertex_only_ply(self, path: Path) -> None:
        # Serve a PLY with only the vertex element, stripped of SHARP's extra
        # extrinsic/intrinsic/etc. elements so GaussianSplats3D can parse it.
        target = path.resolve()
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        stripped = _strip_ply_to_vertex_only(target.read_bytes())
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(stripped)))
        self.end_headers()
        self.wfile.write(stripped)

    def _send_json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = _json_bytes(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, exc: Exception) -> None:
        body = {"error": type(exc).__name__, "message": str(exc)}
        self._send_json(body, HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[web] {self.address_string()} - {format % args}")


def _mime_type(path: Path) -> str:
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")


def run(host: str = "127.0.0.1", port: int = 8765) -> None:
    server = ThreadingHTTPServer((host, port), FluxSharpHandler)
    print(f"Flux Sharp web UI: http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
