# Renderer Spike

## Why This Exists

The MVP can already produce `render_raw.png`, but Open3D and the software fallback are point-cloud preview renderers. They are useful for smoke tests, not for judging SHARP/3DGS quality.

Apple's `ml-sharp` README says SHARP outputs 3D Gaussian Splats in `.ply`, follows OpenCV coordinates `(x right, y down, z forward)`, places the scene center roughly at positive z, and provides `sharp render` for rendering intermediate gaussians. The same README notes that trajectory rendering currently requires CUDA.

## Renderer Backends

```text
auto
  Default. On Windows it uses software fallback to avoid Open3D EGL headless failures.

software
  Pure Python/Pillow point-cloud projection. Ignores Gaussian scale, rotation, opacity, and spherical harmonics.

open3d
  Open3D OffscreenRenderer point-cloud preview. May fail in Windows headless environments and still ignores 3DGS-specific fields.

sharp-cli
  Official SHARP CLI validation path. Runs `sharp render` against the PLY parent directory and copies the first image output.
  This verifies that the official renderer can consume the generated gaussians, but does not yet map this app's CameraParams to an exact single frame.
```

## Validation Checklist

1. Generate or provide a real SHARP `.ply`.
2. Run:

   ```bash
   python app.py --ply inputs/scene.ply --renderer software --backend dummy
   ```

3. Check `manifest.json`:

   ```text
   input.ply_info.is_gaussian_splat == true
   renderer.backend == software
   ```

4. If CUDA and official SHARP are available, run:

   ```bash
   python app.py --ply inputs/scene.ply --renderer sharp-cli --backend dummy
   ```

5. Compare the software preview and official SHARP render. The official render is the quality reference.

## Windows Notes

Use this helper when running CUDA/SHARP commands that need the Visual Studio compiler environment:

```bash
scripts\run_with_vsdevcmd.bat python app.py --ply inputs\scene.ply --renderer sharp-cli --backend dummy
```

The helper loads the VS 2019 BuildTools x64 environment, switches to codepage 936 for PyTorch compiler-version parsing, and injects `/Zc:preprocessor` for CUDA 13.x headers.

Current observed environment:

```text
Python 3.12
PyTorch 2.11.0+cu130
CUDA runtime reported by PyTorch: 13.0
NVIDIA driver CUDA: 13.1
CUDA toolkit selected by nvcc: 13.2
gsplat: 1.5.3
GPU: RTX 4070 Laptop 8GB
```

In this combination, official `sharp render` reaches `gsplat` CUDA extension compilation but fails inside the CUDA/MSVC/Torch header build. This indicates the PLY is valid, while the official renderer environment still needs dependency alignment.

Working Windows setup:

```text
1. Create a dedicated venv:
   python -m venv .venv-sharp

2. Install ml-sharp locked deps:
   .venv-sharp\Scripts\python.exe -m pip install -r D:\apple_SHARP\ml-sharp\requirements.txt

3. Replace CPU Torch with CUDA 12.8 wheels:
   .venv-sharp\Scripts\python.exe -m pip install --force-reinstall torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128

4. Patch gsplat 1.5.3 on Windows:
   In .venv-sharp\Lib\site-packages\gsplat\cuda\_backend.py, remove `-Wno-attributes` from MSVC `extra_cflags`.
   Use `/O2` for MSVC C++ compilation and keep `-O3` for NVCC CUDA compilation.

5. Run through VS BuildTools:
   scripts\run_with_vsdevcmd.bat .venv-sharp\Scripts\python.exe app.py --ply inputs\IMG_0638.ply --renderer sharp-cli --backend dummy
```

Confirmed working environment:

```text
Python 3.12
PyTorch 2.8.0+cu128
Torchvision 0.23.0+cu128
gsplat 1.5.3 with Windows C++ flag patch
VS 2019 BuildTools cl.exe
CUDA toolkit selected by nvcc: 13.2
GPU: RTX 4070 Laptop 8GB
```

SHARP emits `.mp4` renderings. The app extracts the first non-depth video frame into `render_raw.png`.

## Next Implementation Step

The next real engineering step is exact camera mapping:

```text
CameraParams -> OpenCV camera pose/intrinsics -> 3DGS renderer input
```

Until that is done, repair model deployment should remain second priority, because repair quality would be measured on untrusted render input.
