from pathlib import Path

import numpy as np
import pytest

from src.camera import CameraParams


def test_camera_round_trip_json(tmp_path: Path):
    path = tmp_path / "camera.json"
    camera = CameraParams(yaw=30, width=512, height=768)

    camera.to_json(path)
    loaded = CameraParams.from_json(path)

    assert loaded == camera


def test_camera_rejects_invalid_fov():
    with pytest.raises(ValueError, match="fov"):
        CameraParams.from_dict({"fov": 180})


def test_rotation_matrix_changes_eye_position():
    camera = CameraParams(x=0, y=0, z=2, yaw=90)
    eye = camera.eye(np.zeros(3))

    assert eye[0] == pytest.approx(2)
    assert eye[2] == pytest.approx(0, abs=1e-7)
