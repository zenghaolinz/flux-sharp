from __future__ import annotations

import base64
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse
from uuid import uuid4

from src.camera import CameraParams
from src.pipeline import run_pipeline
from src.renderers import create_render_backend
from src.repair import create_repair_backend, load_repair_config


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
UPLOAD_ROOT = ROOT / "web_uploads"
OUTPUT_ROOT = ROOT / "outputs"


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
    files = sorted((ROOT / "inputs").glob("*.ply"))
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
