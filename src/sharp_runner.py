"""Background runner for `sharp predict` (image -> 3DGS .ply).

SHARP (apple/ml-sharp) regresses a 3D Gaussian Splat from a single photograph.
The CLI is synchronous and loads a multi-GB model, so it must not run inside an
HTTP request thread. ``SharpRunner`` submits each job to a dedicated worker
thread and exposes a status poll the front-end can call.

Output contract (from ml-sharp src/sharp/cli/predict.py:148):

    sharp predict -i <image> -o <outdir>
    -> <outdir>/<image_stem>.ply

This runner only invokes the bundled ``sharp`` executable; it never imports the
SHARP Python package or downloads checkpoints itself (the CLI downloads the
default model on first run).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4


# Job lifecycle states.
STATE_PENDING = "pending"
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"


@dataclass
class SharpJob:
    job_id: str
    image_path: Path
    output_dir: Path
    state: str = STATE_PENDING
    ply_path: Path | None = None
    error: str | None = None
    log: str = ""
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "state": self.state,
                "image_path": str(self.image_path),
                "ply_path": str(self.ply_path) if self.ply_path else None,
                "error": self.error,
                "log": self.log,
            }


class SharpRunner:
    """Singleton that runs one ``sharp predict`` at a time on a worker thread."""

    def __init__(self, output_root: Path, sharp_exe: Path | None = None) -> None:
        self.output_root = output_root
        self.output_root.mkdir(parents=True, exist_ok=True)
        self._sharp_exe = sharp_exe or _resolve_sharp_executable()
        self._jobs: dict[str, SharpJob] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run_loop, daemon=True)
        self._queue: list[SharpJob] = []
        self._wakeup = threading.Event()
        self._worker.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def submit(self, image_path: Path) -> SharpJob:
        if self._sharp_exe is None:
            raise RuntimeError(
                "sharp CLI not found. Install apple/ml-sharp into .venv-sharp "
                "or put `sharp` on PATH."
            )
        if not image_path.exists():
            raise FileNotFoundError(f"Input image does not exist: {image_path}")

        job_id = uuid4().hex
        output_dir = self.output_root / f"sharp_{job_id}"
        output_dir.mkdir(parents=True, exist_ok=True)
        job = SharpJob(job_id=job_id, image_path=image_path, output_dir=output_dir)
        with self._lock:
            self._jobs[job_id] = job
            self._queue.append(job)
        self._wakeup.set()
        return job

    def get_status(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
        return job.snapshot() if job else None

    def sharp_available(self) -> bool:
        return self._sharp_exe is not None

    # ------------------------------------------------------------------
    # Worker loop
    # ------------------------------------------------------------------
    def _run_loop(self) -> None:
        while True:
            self._wakeup.wait()
            self._wakeup.clear()
            while True:
                with self._lock:
                    if not self._queue:
                        break
                    job = self._queue.pop(0)
                self._execute(job)

    def _execute(self, job: SharpJob) -> None:
        with job._lock:
            job.state = STATE_RUNNING

        command = [
            str(self._sharp_exe),
            "predict",
            "-i", str(job.image_path),
            "-o", str(job.output_dir),
            "--device", "cuda",
        ]
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=1200,
            )
            combined = (completed.stdout or "") + (completed.stderr or "")
            with job._lock:
                job.log = combined[-8000:]
            if completed.returncode != 0:
                with job._lock:
                    job.state = STATE_FAILED
                    job.error = (
                        f"sharp predict exited with code {completed.returncode}.\n"
                        f"{completed.stderr or completed.stdout or ''}"
                    )
                return

            # Output file is <outdir>/<image_stem>.ply (predict.py:148).
            expected = job.output_dir / f"{job.image_path.stem}.ply"
            ply_path = expected if expected.exists() else _find_first_ply(job.output_dir)
            if ply_path is None:
                with job._lock:
                    job.state = STATE_FAILED
                    job.error = (
                        f"sharp predict finished but no .ply was written to "
                        f"{job.output_dir}.\n{combined[-2000:]}"
                    )
                return
            with job._lock:
                job.state = STATE_DONE
                job.ply_path = ply_path
        except subprocess.TimeoutExpired:
            with job._lock:
                job.state = STATE_FAILED
                job.error = "sharp predict timed out after 1200 seconds."
        except Exception as exc:  # pragma: no cover - defensive
            with job._lock:
                job.state = STATE_FAILED
                job.error = f"{type(exc).__name__}: {exc}"


def _resolve_sharp_executable() -> Path | None:
    """Prefer the project venv's sharp, then PATH."""
    venv_sharp = Path(sys.prefix) / ("Scripts" if sys.platform == "win32" else "bin") / (
        "sharp.exe" if sys.platform == "win32" else "sharp"
    )
    if venv_sharp.exists():
        return venv_sharp
    found = shutil.which("sharp")
    return Path(found) if found else None


def _find_first_ply(directory: Path) -> Path | None:
    candidates = sorted(directory.rglob("*.ply"))
    return candidates[0] if candidates else None
