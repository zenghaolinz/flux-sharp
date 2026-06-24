from pathlib import Path

from src.repair import ComfyUIFluxRepairBackend, create_repair_backend, load_repair_config


def test_dummy_backend_copies_input(tmp_path: Path):
    source = tmp_path / "raw.png"
    target = tmp_path / "repair.png"
    source.write_bytes(b"fake-image")

    backend = create_repair_backend("dummy")
    output = backend.repair(source, target)

    assert output == str(target)
    assert target.read_bytes() == b"fake-image"


def test_external_backend_runs_command(tmp_path: Path):
    source = tmp_path / "raw.png"
    target = tmp_path / "repair.png"
    script = tmp_path / "copy.py"
    source.write_bytes(b"fake-image")
    script.write_text(
        "import shutil, sys\nshutil.copyfile(sys.argv[1], sys.argv[2])\n",
        encoding="utf-8",
    )

    backend = create_repair_backend(
        "external-command",
        {
            "command": [
                "python",
                str(script),
                "{input_image}",
                "{output_image}",
            ],
        },
    )
    output = backend.repair(source, target)

    assert output == str(target)
    assert target.read_bytes() == b"fake-image"


def test_load_repair_config(tmp_path: Path):
    config = tmp_path / "repair.json"
    config.write_text('{"command": ["python"]}', encoding="utf-8")

    assert load_repair_config(config) == {"command": ["python"]}


def test_comfyui_flux_backend_uses_config(tmp_path: Path):
    backend = create_repair_backend(
        "comfyui-flux",
        {
            "server_url": "http://127.0.0.1:9999",
            "input_dir": str(tmp_path / "input"),
            "output_dir": str(tmp_path / "output"),
            "steps": 3,
            "free_memory": False,
        },
    )

    assert isinstance(backend, ComfyUIFluxRepairBackend)
    assert backend.server_url == "http://127.0.0.1:9999"
    assert backend.input_dir == tmp_path / "input"
    assert backend.output_dir == tmp_path / "output"
    assert backend.steps == 3
    assert backend.free_memory is False
