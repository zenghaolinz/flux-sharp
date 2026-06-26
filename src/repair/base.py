from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
import shutil
import subprocess
from typing import Any

from src import decode_subprocess_output


class RepairBackend(ABC):
    name = "base"

    def load(self) -> None:
        pass

    @abstractmethod
    def repair(
        self,
        input_image: str | Path,
        output_path: str | Path,
        reference_image: str | Path | None = None,
        camera_params: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> str:
        pass

    def unload(self) -> None:
        pass


class DummyRepairBackend(RepairBackend):
    name = "dummy"

    def repair(
        self,
        input_image: str | Path,
        output_path: str | Path,
        reference_image: str | Path | None = None,
        camera_params: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> str:
        source = Path(input_image)
        target = Path(output_path)
        if not source.exists():
            raise FileNotFoundError(f"Input image does not exist: {source}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return str(target)


class ExternalCommandRepairBackend(RepairBackend):
    name = "external-command"

    def __init__(
        self,
        command: list[str],
        working_dir: str | Path | None = None,
        environment: dict[str, str] | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        if not command:
            raise ValueError("External repair backend requires a non-empty command.")
        self.command = command
        self.working_dir = Path(working_dir) if working_dir else None
        self.environment = environment or {}
        self.timeout_seconds = timeout_seconds

    def repair(
        self,
        input_image: str | Path,
        output_path: str | Path,
        reference_image: str | Path | None = None,
        camera_params: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> str:
        source = Path(input_image)
        target = Path(output_path)
        if not source.exists():
            raise FileNotFoundError(f"Input image does not exist: {source}")
        target.parent.mkdir(parents=True, exist_ok=True)

        replacements = {
            "{input_image}": str(source),
            "{output_image}": str(target),
            "{reference_image}": str(reference_image or ""),
            "{prompt}": prompt or "",
            "{camera_json}": _camera_json(camera_params),
        }
        command = [_replace_tokens(part, replacements) for part in self.command]
        env = None
        if self.environment:
            import os

            env = os.environ.copy()
            env.update(self.environment)

        completed = subprocess.run(
            command,
            cwd=str(self.working_dir) if self.working_dir else None,
            env=env,
            check=False,
            capture_output=True,
            timeout=self.timeout_seconds,
        )
        stdout = decode_subprocess_output(completed.stdout)
        stderr = decode_subprocess_output(completed.stderr)
        if completed.returncode != 0:
            raise RuntimeError(
                "External repair command failed.\n"
                f"Command: {' '.join(command)}\n"
                f"stdout:\n{stdout}\n"
                f"stderr:\n{stderr}"
            )
        if not target.exists():
            raise RuntimeError(
                f"External repair command completed but did not write output: {target}"
            )
        return str(target)


def _replace_tokens(value: str, replacements: dict[str, str]) -> str:
    result = value
    for key, replacement in replacements.items():
        result = result.replace(key, replacement)
    return result


def _camera_json(camera_params: dict[str, Any] | None) -> str:
    if not camera_params:
        return "{}"
    import json

    return json.dumps(camera_params, separators=(",", ":"))
