// Flux Sharp — Photo → SHARP 3DGS → 3D Preview → Screenshot → ComfyUI Repair
//
// Flow:
//   1. Upload photo
//   2. SHARP generates PLY from photo
//   3. PLY loaded in GaussianSplats3D viewer (user adjusts camera)
//   4. Screenshot current view → send to ComfyUI for repair
//   5. Compare (screenshot vs repair) / Export repair result

import * as THREE from "three";
import { Viewer, SceneFormat } from "/web/vendor/gaussian-splats-3d.module.js";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Repair prompt builder — fills in camera movement coordinates.
// ---------------------------------------------------------------------------
function buildRepairPrompt(camMove) {
  const m = camMove;
  return (
    `Referring to the scene in image 1, restore the perspective of the scene in image 2. ` +
    `Repair the perspective and missing areas. ` +
    `The camera has moved by: ` +
    `{"x":${m.x},"y":${m.y},"z":${m.z},"pitch":${m.pitch},"yaw":${m.yaw},"roll":${m.roll}}`
  );
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
const state = {
  photoWidth: 0,        // original photo width (px)
  photoHeight: 0,       // original photo height (px)
  photoDataUrl: null,   // uploaded photo data URL
  photoName: null,      // original filename
  plyPath: null,        // generated PLY path from SHARP
  plyUrl: null,         // PLY URL for loading into viewer
  viewer: null,         // GaussianSplats3D Viewer instance
  disposePromise: null,  // pending viewer disposal promise
  screenshotUrl: null,  // canvas screenshot URL (from ComfyUI response)
  repairUrl: null,      // repair result URL
  comparing: false,     // true = showing screenshot, false = showing repair
  inRepairView: false,  // true = repair result is showing, preview image overlays canvas
  initialCameraPos: null,   // THREE.Vector3 — camera position at initial view
  initialCameraQuat: null,  // THREE.Quaternion — camera orientation at initial view
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showError(msg) {
  const el = $("errorToast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("visible"), 5000);
}

function setBusy(show, text) {
  const overlay = $("busyOverlay");
  if (text) $("busyText").textContent = text;
  overlay.classList.toggle("visible", show);
}

function showModeBadge(text) {
  const badge = $("modeBadge");
  badge.textContent = text;
  badge.classList.toggle("visible", !!text);
  clearTimeout(badge._timer);
  if (text) {
    badge._timer = setTimeout(() => badge.classList.remove("visible"), 2000);
  }
}

function showViewHint(show) {
  $("viewHint").classList.toggle("visible", show);
}

// ---------------------------------------------------------------------------
// Frame: constrains 3D canvas & preview image to uploaded photo aspect ratio.
// Acts like a “window” — splat rendering is clipped, no overflow on rotate.
// ---------------------------------------------------------------------------
function updateFrameSize() {
  if (!state.photoWidth || !state.photoHeight) return;
  const previewEl = $("preview");
  const pw = previewEl.clientWidth;
  const ph = previewEl.clientHeight;
  if (!pw || !ph) return;

  const photoRatio = state.photoWidth / state.photoHeight;
  const screenRatio = pw / ph;

  let frameW, frameH;
  if (photoRatio > screenRatio) {
    // Photo is wider — fit to width.
    frameW = pw;
    frameH = pw / photoRatio;
  } else {
    // Photo is taller — fit to height.
    frameH = ph;
    frameW = ph * photoRatio;
  }

  const frame = $("frame");
  frame.style.width = frameW + "px";
  frame.style.height = frameH + "px";

  // Update camera aspect ratio so 3D content isn't stretched.
  if (state.viewer && state.viewer.camera) {
    state.viewer.camera.aspect = frameW / frameH;
    state.viewer.camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------
// Photo upload
// ---------------------------------------------------------------------------
function onPhotoSelected(file) {
  if (!file) return;
  state.photoName = file.name;
  state.plyPath = null;
  state.plyUrl = null;
  state.screenshotUrl = null;
  state.repairUrl = null;
  state.comparing = false;
  state.inRepairView = false;

  // Dispose previous viewer if any (fire-and-forget; loadSplatPreview awaits it).
  disposeViewer();
  // Deactivate 3D canvas container (show photo instead).
  $("canvasContainer").classList.remove("active");

  const reader = new FileReader();
  reader.onload = () => {
    state.photoDataUrl = reader.result;

    // Save original photo dimensions for frame aspect ratio.
    const tmpImg = new Image();
    tmpImg.onload = () => {
      state.photoWidth = tmpImg.naturalWidth;
      state.photoHeight = tmpImg.naturalHeight;
      updateFrameSize();
    };
    tmpImg.src = reader.result;

    // Show frame + uploaded photo.
    $("frame").classList.add("active");
    const img = $("previewImg");
    img.src = reader.result;
    img.classList.add("visible");

    // Hide upload prompt, show generate button.
    $("uploadPrompt").classList.add("hidden");
    $("generateBtn").classList.remove("hidden");
    $("generateBtn").disabled = false;

    // Hide post-generate buttons and repair button.
    $("postGroup").classList.add("hidden");
    $("repairBtn").classList.add("hidden");
    showModeBadge("");
    showViewHint(false);
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------------------
// Generate: SHARP predict (photo → PLY) → load 3D preview
// ---------------------------------------------------------------------------
async function generate() {
  if (!state.photoDataUrl) {
    showError("请先上传一张照片");
    return;
  }

  $("generateBtn").disabled = true;

  try {
    // ── Stage 1: SHARP — photo → 3DGS .ply ──
    setBusy(true, "正在生成 3D 模型…");
    const sharpData = await api("/api/sharp/generate", {
      method: "POST",
      body: JSON.stringify({
        imageData: state.photoDataUrl,
        imageName: state.photoName,
      }),
    });

    // Poll SHARP status until done.
    const plyPath = await pollSharpDone(sharpData.job_id);
    state.plyPath = plyPath;

    // Build PLY URL (use vertex-only endpoint for GaussianSplats3D compat).
    const plyUrl = `/api/ply-vertex-only?path=${encodeURIComponent(plyPath)}`;
    state.plyUrl = plyUrl;

    // ── Stage 2: Load PLY into 3D viewer ──
    // Hide our busy overlay — GaussianSplats3D shows its own loading spinner
    // inside the canvas container, which gives better progress feedback.
    setBusy(false);
    try {
      await loadSplatPreview(plyUrl);
    } catch (loadErr) {
      console.error("[generate] 3D preview load failed:", loadErr);
      throw new Error("3D 预览加载失败: " + (loadErr.message || String(loadErr)));
    }

    // Transition to 3D preview mode.
    $("generateBtn").classList.add("hidden");
    $("repairBtn").classList.remove("hidden");
    showViewHint(true);
  } catch (err) {
    setBusy(false);
    showError(err.message || String(err));
    $("generateBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 3D Splat Preview (GaussianSplats3D)
// ---------------------------------------------------------------------------
async function loadSplatPreview(plyUrl) {
  // Wait for any pending disposal from onPhotoSelected.
  if (state.disposePromise) {
    await state.disposePromise;
    state.disposePromise = null;
  }

  const container = $("canvasContainer");

  console.log("[loadSplatPreview] Creating viewer, PLY URL:", plyUrl);

  // Create GaussianSplats3D viewer.
  // - It creates its own renderer (with preserveDrawingBuffer: true),
  //   camera, and OrbitControls internally.
  // - Canvas is appended to rootElement (canvasContainer).
  const viewer = new Viewer({
    rootElement: container,
    cameraUp: [0, -1, 0], // Flip Y-up to fix inverted model from SHARP
    initialCameraPosition: [0, 0, -1.5],
    initialCameraLookAt: [0, 0, 0],
    sceneRevealMode: 2, // SceneRevealMode.Instant — show immediately
    // SharedArrayBuffer requires Cross-Origin-Isolation headers which our
    // simple HTTP server doesn't set. Disable to avoid DataCloneError.
    sharedMemoryForWorkers: false,
  });

  state.viewer = viewer;

  // Activate canvas container BEFORE loading so GaussianSplats3D's
  // built-in loading spinner and progress bar are visible to the user.
  container.classList.add("active");
  $("previewImg").classList.remove("visible");

  // Load the PLY file.
  // NOTE: Must pass format explicitly because the URL (/api/ply-vertex-only?path=...)
  // doesn't end with .ply, so GaussianSplats3D can't auto-detect the format.
  console.log("[loadSplatPreview] Loading splat scene...");
  try {
    await viewer.addSplatScene(plyUrl, { format: SceneFormat.Ply });
  } catch (loadErr) {
    // Loading failed — deactivate canvas so user sees the photo again.
    container.classList.remove("active");
    $("previewImg").classList.add("visible");
    throw loadErr;
  }
  console.log("[loadSplatPreview] Splat scene loaded, starting render loop.");

  // Start the self-driven render loop.
  viewer.start();

  // ── Camera positioning ──
  // Try to read the original camera parameters (extrinsic + intrinsic)
  // embedded in the SHARP PLY. If available, position the Three.js camera
  // to exactly match the original photo's viewpoint. Otherwise fall back
  // to bounding-box auto-fit.
  const splatMesh = viewer.splatMesh;
  if (splatMesh && splatMesh.getSplatCount() > 0) {
    const bbox = splatMesh.computeBoundingBox(true);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const camera = viewer.camera;

    // ── Fetch PLY camera parameters ──
    let camParams = null;
    if (state.plyPath) {
      try {
        const camData = await api(
          `/api/ply-camera?path=${encodeURIComponent(state.plyPath)}`
        );
        if (camData.available) {
          camParams = camData;
        }
      } catch (e) {
        console.warn("[loadSplatPreview] Failed to fetch PLY camera params:", e);
      }
    }

    if (camParams) {
      // ── Use PLY extrinsic + intrinsic for exact viewpoint match ──
      // Extrinsic E is a 4×4 row-major world→camera matrix: [R|t; 0 1]
      // Camera position in world:  C = -R^T · t
      // Camera forward in world:   R row 3 (the +Z axis in camera space)
      // Camera up in world:       -R row 2 (the -Y axis in camera space)
      const E = camParams.extrinsic;   // 16 floats
      const K = camParams.intrinsic;   // 9 floats
      const [imgW, imgH] = camParams.image_size;

      // Extract R (3×3) and t (3×1) from the 4×4 extrinsic.
      const R = [
        [E[0], E[1], E[2]],
        [E[4], E[5], E[6]],
        [E[8], E[9], E[10]],
      ];
      const t = [E[3], E[7], E[11]];

      // C = -R^T · t
      const Cx = -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]);
      const Cy = -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]);
      const Cz = -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]);

      // Forward direction = third row of R
      const dx = R[2][0], dy = R[2][1], dz = R[2][2];
      // Up direction = negative second row of R
      const ux = -R[1][0], uy = -R[1][1], uz = -R[1][2];

      // Set camera position, up, and look-at direction.
      camera.position.set(Cx, Cy, Cz);
      camera.up.set(ux, uy, uz);
      camera.lookAt(Cx + dx, Cy + dy, Cz + dz);

      // Set vertical FOV from intrinsic matrix.
      // K[0] = fx, K[4] = fy (row-major 3×3)
      const fy = K[4];
      if (fy > 0 && imgH > 0) {
        const fovRad = 2 * Math.atan(imgH / (2 * fy));
        camera.fov = (fovRad * 180) / Math.PI;
      }
      camera.updateProjectionMatrix();

      console.log(
        `[loadSplatPreview] PLY camera: pos=(${Cx.toFixed(2)}, ${Cy.toFixed(2)}, ${Cz.toFixed(2)}), ` +
        `dir=(${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)}), ` +
        `up=(${ux.toFixed(2)}, ${uy.toFixed(2)}, ${uz.toFixed(2)}), ` +
        `fov=${camera.fov.toFixed(1)}°, imgSize=${imgW}×${imgH}`
      );

      // ── OrbitControls target: project model center onto forward ray ──
      // The bounding-box center can be pulled far off-axis by outlier
      // splats.  Projecting it onto the camera's forward ray keeps the
      // orbit target on the view direction while preserving a reasonable
      // depth for rotation.
      if (viewer.controls && viewer.controls.target) {
        const fwdLen = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const nfx = dx / fwdLen, nfy = dy / fwdLen, nfz = dz / fwdLen;
        // Vector from camera to model center
        const vx = center.x - Cx, vy = center.y - Cy, vz = center.z - Cz;
        // Project onto forward ray
        const proj = vx * nfx + vy * nfy + vz * nfz;
        viewer.controls.target.set(
          Cx + nfx * proj,
          Cy + nfy * proj,
          Cz + nfz * proj
        );
        viewer.controls.update();
      }
    } else {
      // ── Fallback: bounding-box auto-fit ──
      const fovRad = (camera.fov * Math.PI) / 180;
      const padding = 1.9;
      const dist = (size.y / 2) / Math.tan(fovRad / 2) / padding;
      camera.position.set(center.x, center.y, center.z - dist);
      camera.lookAt(center);
      camera.updateProjectionMatrix();

      // OrbitControls target = model center (standard for fallback).
      if (viewer.controls && viewer.controls.target) {
        viewer.controls.target.copy(center);
        viewer.controls.update();
      }

      console.log(
        `[loadSplatPreview] Fallback auto-fit: center=(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}), ` +
        `size=(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}), dist=${dist.toFixed(2)}`
      );
    }

    // ── Record initial camera state for rotation tracking ──
    // Store position & quaternion AFTER all camera setup (including
    // OrbitControls target + update) so the delta reflects user rotation.
    state.initialCameraPos = camera.position.clone();
    state.initialCameraQuat = camera.quaternion.clone();
    console.log(
      `[loadSplatPreview] Initial camera: pos=(${state.initialCameraPos.x.toFixed(2)}, ${state.initialCameraPos.y.toFixed(2)}, ${state.initialCameraPos.z.toFixed(2)}), ` +
      `quat=(${state.initialCameraQuat.x.toFixed(3)}, ${state.initialCameraQuat.y.toFixed(3)}, ${state.initialCameraQuat.z.toFixed(3)}, ${state.initialCameraQuat.w.toFixed(3)})`
    );
  }

  // Attach real-time edge feathering post-processing.
  setupSplatPostProcessing(viewer);

  // Update camera aspect ratio to match the frame.
  updateFrameSize();
}

// ---------------------------------------------------------------------------
// Real-time splat edge feathering post-processing.
// Monkey-patches viewer.render() to:
//   1. Render splats to an offscreen render target
//   2. Run a GPU shader that does alpha-based edge dilation + Gaussian blur
//      for smooth feathered splat boundaries (no hard edges).
// ---------------------------------------------------------------------------
function setupSplatPostProcessing(viewer) {
  const renderer = viewer.renderer;

  // ── Offscreen render target for splat scene ──
  const rtSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(rtSize);

  const splatRT = new THREE.WebGLRenderTarget(rtSize.x, rtSize.y, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  // ── Fullscreen quad + edge-feathering shader ──
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const postMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tSplat:       { value: splatRT.texture },
      uResolution:  { value: new THREE.Vector2(rtSize.x, rtSize.y) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tSplat;
      uniform vec2 uResolution;
      varying vec2 vUv;

      void main() {
        vec2 texel = 1.0 / uResolution;
        vec4 center = texture2D(tSplat, vUv);

        // ── Alpha-weighted colour dilation (5×5) ──
        // Propagate splat edge colour into nearby holes for gap-filling.
        vec3 dilatedCol = center.rgb * max(center.a, 0.001);
        float dilatedW  = max(center.a, 0.001);

        for (int dy = -2; dy <= 2; dy++) {
          for (int dx = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) continue;
            vec2 off = vec2(float(dx), float(dy)) * texel;
            vec4 s = texture2D(tSplat, vUv + off);
            float d = length(vec2(float(dx), float(dy)));
            float w = s.a * max(0.0, 1.0 - d * 0.28);
            dilatedCol += s.rgb * w;
            dilatedW  += w;
          }
        }
        dilatedCol /= max(dilatedW, 0.001);

        // ── Edge-aware Gaussian blur (7×7, sigma=2.5) ──
        // Only active near splat boundaries for feathering.
        float edgeMask = smoothstep(0.15, 0.75, center.a)
                       * (1.0 - smoothstep(0.75, 0.98, center.a));

        vec3 blurred = dilatedCol;
        float bW = 1.0;
        float sigma = 2.5;
        for (int dy = -3; dy <= 3; dy++) {
          for (int dx = -3; dx <= 3; dx++) {
            if (dx == 0 && dy == 0) continue;
            vec2 off = vec2(float(dx), float(dy)) * texel;
            vec4 s = texture2D(tSplat, vUv + off);
            float d2 = float(dx*dx + dy*dy);
            float g = exp(-d2 / (2.0 * sigma * sigma));
            blurred += s.rgb * g;
            bW += g;
          }
        }
        blurred /= bW;

        // Interior keeps original colour; edges get feathered fill.
        vec3 rgb = mix(dilatedCol, blurred, edgeMask * 0.7);

        // Smooth the alpha at splat boundaries for a soft edge.
        float alpha = smoothstep(0.0, 0.12, center.a);

        gl_FragColor = vec4(rgb, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
  const postScene = new THREE.Scene();
  postScene.add(postQuad);

  // ── Patch viewer.render() ──
  const originalRender = viewer.render.bind(viewer);
  viewer.render = function () {
    const savedAutoClear = renderer.autoClear;

    // Resize render target if canvas size changed.
    const curSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(curSize);
    if (curSize.x !== splatRT.width || curSize.y !== splatRT.height) {
      splatRT.setSize(curSize.x, curSize.y);
      postMaterial.uniforms.uResolution.value.set(curSize.x, curSize.y);
    }

    // 1. Render splat scene to offscreen target.
    renderer.setRenderTarget(splatRT);
    renderer.autoClear = true;
    originalRender();

    // 2. Edge-feathering pass → screen.
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(postScene, postCamera);

    renderer.autoClear = savedAutoClear;
  };
}

function disposeViewer() {
  if (state.viewer) {
    const v = state.viewer;
    state.viewer = null;
    state.disposePromise = v.dispose().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Screenshot: capture current 3D view as data URL
// Captures at original photo resolution for consistent size with input.
// ---------------------------------------------------------------------------
function captureScreenshot() {
  const viewer = state.viewer;
  if (!viewer || !viewer.renderer) {
    throw new Error("3D 预览未就绪");
  }

  return new Promise((resolve, reject) => {
    // Force a render so the canvas has the latest frame, then capture.
    requestAnimationFrame(() => {
      try {
        const canvas = viewer.renderer.domElement;

        // Capture at canvas resolution — the canvas is sized to match
        // the frame, which already has the photo's aspect ratio.
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvas.width;
        offscreenCanvas.height = canvas.height;
        const ctx = offscreenCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, 0);

        resolve(offscreenCanvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Compute camera movement delta (position + rotation) from initial view.
// Returns { x, y, z, pitch, yaw, roll } with position in world units and
// angles in degrees.  Rotation is computed as the quaternion delta
// (current × initial⁻¹) converted to Euler angles in 'YXZ' order so that
// Y = yaw, X = pitch, Z = roll.
// ---------------------------------------------------------------------------
function computeCameraMove() {
  if (!state.viewer || !state.initialCameraPos || !state.initialCameraQuat) {
    return { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  }

  const camera = state.viewer.camera;
  const curPos = camera.position;
  const curQuat = camera.quaternion;

  // Position delta (world space = initial camera space for identity extrinsic).
  const dx = curPos.x - state.initialCameraPos.x;
  const dy = curPos.y - state.initialCameraPos.y;
  const dz = curPos.z - state.initialCameraPos.z;

  // Rotation delta: Δq = q_current · q_initial⁻¹
  const invInit = state.initialCameraQuat.clone().invert();
  const deltaQuat = curQuat.clone().multiply(invInit);

  // Convert to Euler angles (YXZ order: yaw=Y, pitch=X, roll=Z).
  const euler = new THREE.Euler().setFromQuaternion(deltaQuat, "YXZ");

  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    x: round2(dx),
    y: round2(dy),
    z: round2(dz),
    pitch: round2(THREE.MathUtils.radToDeg(euler.x)),
    yaw: round2(THREE.MathUtils.radToDeg(euler.y)),
    roll: round2(THREE.MathUtils.radToDeg(euler.z)),
  };
}

// ---------------------------------------------------------------------------
// Repair: screenshot current view → send to ComfyUI
// ---------------------------------------------------------------------------
async function repair() {
  if (!state.viewer) {
    showError("3D 预览未就绪");
    return;
  }

  try {
    // Capture screenshot of current 3D view.
    setBusy(true, "正在截取画面…");
    const screenshotDataUrl = await captureScreenshot();

    // ── Compute camera movement delta ──
    const camMove = computeCameraMove();
    console.log("[repair] Camera move:", camMove);

    // Build prompt with camera movement coordinates.
    const prompt = buildRepairPrompt(camMove);

    // Send original photo + screenshot to ComfyUI for repair.
    setBusy(true, "正在修复图像…");
    const repairData = await api("/api/repair-screenshot", {
      method: "POST",
      body: JSON.stringify({
        photo: state.photoDataUrl,
        screenshot: screenshotDataUrl,
        prompt: prompt,
        steps: 4,
        megapixels: 1,
        ply_path: state.plyPath,
      }),
    });

    state.screenshotUrl = repairData.screenshot_url;
    state.repairUrl = repairData.repair_url;

    // Hide 3D canvas — repair result is now showing.
    $("canvasContainer").classList.remove("active");

    // Show repair result inside the frame.
    const img = $("previewImg");
    img.src = `${state.repairUrl}&t=${Date.now()}`;
    img.classList.add("visible");
    state.inRepairView = true;

    // Reset restore button text.
    $("restoreBtn").textContent = "恢复3D";

    // Switch buttons: hide repair, show compare + export.
    $("repairBtn").classList.add("hidden");
    showViewHint(false);
    $("postGroup").classList.remove("hidden");
    state.comparing = false;
    showModeBadge("修复结果");
    $("compareBtn").classList.remove("active");
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Compare: toggle between screenshot (原图) and repair result (修复结果)
// ---------------------------------------------------------------------------
function toggleCompare() {
  if (!state.repairUrl) return;

  state.comparing = !state.comparing;
  const img = $("previewImg");

  if (state.comparing) {
    // Show the original uploaded photo.
    img.src = state.photoDataUrl || "";
    showModeBadge("原图");
    $("compareBtn").classList.add("active");
  } else {
    // Show repair result.
    img.src = `${state.repairUrl}&t=${Date.now()}`;
    showModeBadge("修复结果");
    $("compareBtn").classList.remove("active");
  }
}

// ---------------------------------------------------------------------------
// Restore 3D preview: show the canvas again with the same camera state as
// when the user clicked "修复". The viewer is still in memory so the render
// loop resumes automatically.
// ---------------------------------------------------------------------------
function restorePreview() {
  if (!state.viewer) return;

  // Show 3D canvas, hide preview image.
  $("canvasContainer").classList.add("active");
  $("previewImg").classList.remove("visible");

  // Reset state flags.
  state.comparing = false;
  state.inRepairView = false;
  showModeBadge("");
  showViewHint(true);
  $("compareBtn").classList.remove("active");

  // Toggle button text so user can go back to repair result.
  $("restoreBtn").textContent = "查看结果";
}

function showRepairResult() {
  if (!state.repairUrl) return;

  // Hide 3D canvas, show repair image.
  $("canvasContainer").classList.remove("active");
  const img = $("previewImg");
  img.src = `${state.repairUrl}&t=${Date.now()}`;
  img.classList.add("visible");
  state.inRepairView = true;
  state.comparing = false;
  showModeBadge("修复结果");
  showViewHint(false);
  $("compareBtn").classList.remove("active");

  // Toggle button text back.
  $("restoreBtn").textContent = "恢复3D";
}

// ---------------------------------------------------------------------------
// Export: download the repair result image
// ---------------------------------------------------------------------------
async function exportResult() {
  if (!state.repairUrl) return;

  try {
    const response = await fetch(state.repairUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flux-sharp-repair-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showError("导出失败: " + (err.message || String(err)));
  }
}

// ---------------------------------------------------------------------------
// Poll SHARP status until done or failed
// ---------------------------------------------------------------------------
function pollSharpDone(jobId) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const status = await api(`/api/sharp/status?job_id=${encodeURIComponent(jobId)}`);
        if (status.state === "done" && status.ply_path) {
          resolve(status.ply_path);
          return;
        }
        if (status.state === "failed") {
          reject(new Error(status.error || "SHARP 生成失败"));
          return;
        }
        setTimeout(tick, 2000);
      } catch (err) {
        reject(err);
      }
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Status polling (API + ComfyUI health)
// ---------------------------------------------------------------------------
async function refreshStatus() {
  try {
    await api("/api/health");
    $("healthDot").classList.toggle("ready", true);
  } catch {
    $("healthDot").classList.remove("ready");
  }

  try {
    const data = await api("/api/comfyui-status");
    $("comfyuiDot").classList.toggle("ready", !!data.online);
    $("comfyuiDot").classList.toggle("offline", !data.online);
  } catch {
    $("comfyuiDot").classList.remove("ready");
    $("comfyuiDot").classList.add("offline");
  }
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
async function init() {
  // Wire up events.
  $("photoInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) onPhotoSelected(file);
  });

  $("generateBtn").addEventListener("click", () => {
    generate().catch((err) => showError(err.message));
  });

  $("repairBtn").addEventListener("click", () => {
    repair().catch((err) => showError(err.message));
  });

  $("compareBtn").addEventListener("click", toggleCompare);

  $("restoreBtn").addEventListener("click", () => {
    if (state.inRepairView) {
      restorePreview();
    } else {
      showRepairResult();
    }
  });

  $("exportBtn").addEventListener("click", () => {
    exportResult().catch((err) => showError(err.message));
  });

  // Window resize: update frame dimensions.
  window.addEventListener("resize", updateFrameSize);

  // Initial status check + polling.
  await refreshStatus();
  setInterval(refreshStatus, 15000);
}

init().catch((err) => showError(err.message || String(err)));
