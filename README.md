# Flux Sharp

[English](README.en.md) | 中文

单张照片 → 3D 高斯泼溅 → 视角修复的本地管线，附带浏览器交互界面。

上传一张照片，用 Apple [ml-sharp](https://github.com/apple/ml-sharp) 回归出
3DGS `.ply`，在 WebGL 预览中旋转到想要的视角，再把该视角的 3DGS 原始截图连同原图
一起发给 ComfyUI 的 FLUX.2 Klein 9B 工作流，完成空洞填补重构。

```text
照片 ──sharp predict──▶ 3DGS .ply ──WebGL 旋转──▶ 原始截图
   │                                          │
   └─────────────▶ ComfyUI FLUX.2 Klein ◀─────┘
                   (原图 + 截图 双图修复) ──▶ 修复结果
```

3D 预览、修复触发、图库都跑在浏览器里。Python 后端只负责运行 `sharp predict`、
中转 ComfyUI 调用、以及提供文件服务。

## 快速开始（Windows）

```bat
start.bat
```

`start.bat` 使用项目自带的 `.venv-sharp` 解释器，启动 web UI 到
<http://127.0.0.1:8765>。在控制台按 `Ctrl+C` 停止。

### 手动启动

```bash
python web_server.py          # 访问 http://127.0.0.1:8765
```

### 需要运行的服务

| 服务 | 地址 | 启动方 |
|------|------|--------|
| Flux Sharp web UI | `127.0.0.1:8765` | `web_server.py`（本项目） |
| ComfyUI | `127.0.0.1:8188` | **手动启动**，不会自动拉起 |
| `sharp` CLI | 在 PATH 或 `.venv-sharp/Scripts/` 中 | 自带环境 |

web UI 会显示 API 与 ComfyUI 的实时状态指示灯。点 **重构** 前需确保 ComfyUI 在线；
点 **生成** 时按需运行 `sharp predict`。

## 环境

项目自带一个专用虚拟环境 `.venv-sharp/`，用于 SHARP / CUDA 栈：

- `torch==2.8.0+cu128`、`torchvision==0.23.0+cu128`、`gsplat==1.5.3`
- `sharp` CLI（首次 `sharp predict` 会自动下载默认 checkpoint）
- 一块 CUDA GPU——运行器强制 `--device cuda`

Web/后端依赖见 `requirements.txt`（`numpy`、`open3d`、`Pillow`、`requests`、
`websocket-client`、`huggingface-hub`、`pytest`），装进运行 web UI 的同一个解释器：

```bash
.venv-sharp\Scripts\python.exe -m pip install -r requirements.txt
```

## 工作原理

### 1. 上传 → 图库

照片上传到 `/api/gallery/import`，存到 `web_uploads/gallery/`，并在
`web_uploads/gallery/gallery.json` 中登记。图库**只存原图**——3DGS `.ply`、截图、
修复结果都是内存态工作流数据，不持久化。允许重复上传，每条各自独立保留。

### 2. 生成 —— SHARP 图像 → 3DGS PLY

点 **生成** 会排队一个后台 `sharp predict` 任务（`src/sharp_runner.py`）：

```text
sharp predict -i <照片> -o <输出目录> --device cuda  ->  <输出目录>/<词干>.ply
```

同一时刻只跑一个任务（单 GPU）。UI 轮询 `/api/sharp/status` 直到 `.ply` 就绪，
再加载进 GaussianSplats3D 查看器。

### 3. 旋转 → 截图

PLY 用内置的 `GaussianSplats3D` 库（Three.js）在浏览器里渲染。轨道控制做了阻尼
并调慢，便于精修视角。加载时播放照片→3DGS 交叉淡入过渡，避免黑帧。

### 4. 重构 —— ComfyUI 双图修复

点 **重构** 会截取**原始** 3DGS 渲染目标（在任何 UI 羽化之前）连同原图，一起提交
给 ComfyUI。修复期间会锁定预览，确保截图与点击时刻可见的相机一致。

客户端（`src/comfyui_client.py`）加载项目根目录下的 API 格式工作流——
**`高斯泼溅修复工作流.json`**——只改输入字段（不动结构与模型加载器），走官方
WebSocket + History 流程：`/upload/image` → `/prompt` → 在 `/ws` 监听 `executing`
且 `node is null` → `/history/{prompt_id}` → `/view`。

#### 工作流节点契约

| 节点 | Class type            | 改写的输入            |
|------|-----------------------|----------------------|
| 81   | LoadImage             | `image`（截图）       |
| 158  | LoadImage             | `image`（原图）       |
| 106  | CLIPTextEncode        | `text`（prompt）      |
| 103  | RandomNoise           | `noise_seed`         |
| 99   | Flux2Scheduler        | `steps`              |
| 108  | ImageScaleToTotalPixels | `megapixels`（图1） |
| 109  | ImageScaleToTotalPixels | `megapixels`（图2） |
| 94   | SaveImage             | （输出源）            |

修复 prompt 由初始视角与所选视角之间的相机移动量构建（见 `web/app.js` 中的
`buildRepairPrompt` / `computeCameraMove`）。

## HTTP API

由 `web_server.py` 在 `127.0.0.1:8765` 提供。

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/health` | GET | 后端存活检测 |
| `/api/comfyui-status` | GET | ComfyUI 在线检测（`127.0.0.1:8188/system_stats`） |
| `/api/gallery` | GET | 列出图库条目（仅原图，最新在前） |
| `/api/gallery/import` | POST | 上传新原图（SHA-256 哈希，允许重复） |
| `/api/gallery/upsert` | POST | 向后兼容的 upsert（仅原图） |
| `/api/gallery/update` | POST | 更新条目元数据 |
| `/api/sharp/generate` | POST | 为某条目排队 `sharp predict` 任务 |
| `/api/sharp/status` | GET | 轮询运行中的 SHARP 任务 |
| `/api/sharp/ply` | GET | 取某条目生成的 `.ply` |
| `/api/ply-vertex-only` | GET | 给查看器流式传输仅顶点的 PLY |
| `/api/ply-camera` | GET | 从 PLY 读取相机参数 |
| `/api/ply-files` | GET | 列出 `inputs/` 下的 PLY |
| `/api/repair-screenshot` | POST | 把原图+截图提交给 ComfyUI，返回修复图 |
| `/api/sessions` | POST | 创建上传会话目录 |
| `/api/export-camera` | POST | 导出 `CameraParams` JSON |
| `/api/run-preview` | POST | 遗留服务端渲染（保留用于调试，UI 不用） |
| `/api/file` | GET | 通用静态文件透传 |

## 项目结构

```text
web_server.py              Web UI + API 服务（入口）
start.bat                  一键启动器（.venv-sharp）
src/
  sharp_runner.py          后台 `sharp predict` 运行器（单例，单 GPU 任务）
  comfyui_client.py        ComfyUI WebSocket 客户端 + 双图工作流驱动
  pipeline.py              遗留渲染/修复管线（CLI 路径）
  camera.py, ply_loader.py, renderer.py, renderers/   渲染器后端
  repair/                  修复后端（comfyui_flux.py 为遗留单图）
web/
  app.js, index.html, style.css   浏览器 UI（GaussianSplats3D + Three.js）
  vendor/                  内置 three.module.js、PLYLoader、OrbitControls、
                           gaussian-splats-3d.module.js（可离线运行）
configs/                   相机与修复配置（default_camera.json、repair_config.json 等）
scripts/                   kill_port.ps1、probe_ply_camera.py、run_with_vsdevcmd.bat 等
高斯泼溅修复工作流.json      ComfyUI API 格式工作流（双图 FLUX.2 Klein 9B）
docs/                      renderer-spike.md、repair-backends.md
models/                    VGGT splat-render 配置
inputs/  outputs/  web_uploads/   运行时数据（图库原图在 web_uploads/gallery/）
```

## CLI（遗留）

`app.py` 是最初的 CLI 管线（`--ply`、`--camera`、`--renderer`、`--backend`），
保留用于渲染器/修复调试与冒烟测试，但不是主流程——主流程是 web UI。渲染器后端：
`auto`、`software`（Pillow 投影）、`open3d`（点云预览）、`sharp-cli`（官方
ml-sharp，CUDA）。详见 `docs/renderer-spike.md`。

```bash
scripts\run_with_vsdevcmd.bat .venv-sharp\Scripts\python.exe app.py \
  --ply inputs/scene.ply --renderer sharp-cli --backend dummy
```

## 备注

- 浏览器截取的是**原始** 3DGS 截图（带黑洞/稀疏区域），以匹配 LoRA 修复的训练域。
  用户可见的预览可以做视觉柔化，但发给 ComfyUI 的始终是原始渲染。
- 修复客户端在修复前后都会调用 ComfyUI 的 `/free`，让 SHARP 阶段与 Flux 修复阶段
  不会同时占用显存。
- Three.js、PLYLoader、OrbitControls、GaussianSplats3D 均内置在 `web/vendor/`，
  页面可完全离线运行。
