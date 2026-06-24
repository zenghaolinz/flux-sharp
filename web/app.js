// Browser PLY preview + screenshot-to-ComfyUI repair flow.
// Loads a selected PLY with Three.js + PLYLoader, lets the user orbit with
// OrbitControls, then captures the canvas and sends it to /api/repair-screenshot.

import * as THREE from "three";
import { OrbitControls } from "/web/vendor/OrbitControls.js";
import { PLYLoader } from "/web/vendor/PLYLoader.js";
import { Viewer } from "@mkkellogg/gaussian-splats-3d";

// Debug switch: when true, 3DGS PLYs render as a plain colored point cloud
// (PointsMaterial) to verify the parser, f_dc->RGB color, coordinate flip, and
// camera framing are correct — independent of the splat shader. If this mode
// shows a colored subject, the bug is in createSplatMaterial; if it's still
// grey/white dots, the bug is in the parser/framing.
const DEBUG_POINT_PREVIEW = false;

const $ = (id) => document.getElementById(id);

const state = {
  // Three.js scene objects, created in initViewer().
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  currentMesh: null,
};

// ---------------------------------------------------------------------------
// Three.js viewer
// ---------------------------------------------------------------------------
function initViewer() {
  const canvas = $("viewerCanvas");
  const wrap = canvas.parentElement;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f24);

  const camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight, 0.01, 1000);
  camera.position.set(0, 0, 3);

  // preserveDrawingBuffer is required so canvas.toDataURL() returns a stable
  // screenshot after a manual render() call. powerPreference forces the
  // discrete GPU on dual-GPU laptops (Chrome otherwise pins WebGL to the
  // Intel iGPU, which is slow and janky for >1M points).
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // Re-render on interaction for the on-demand loop.
  controls.addEventListener("change", requestRender);
  controls.addEventListener("start", requestRender);

  // Soft lighting so unlit PLY point clouds are still readable.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(2, 3, 2);
  scene.add(dir);

  state.scene = scene;
  state.camera = camera;
  state.renderer = renderer;
  state.controls = controls;

  // If the GPU drops the WebGL context (heavy scenes on weak drivers), restore
  // and re-render once it comes back so the viewer isn't left blank.
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    requestRender();
  });

  window.addEventListener("resize", onResize);
  startAnimation();
}

function onResize() {
  const wrap = $("viewerCanvas").parentElement;
  state.camera.aspect = wrap.clientWidth / wrap.clientHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
  updateViewportUniform();
  requestRender();
}

// Keep the splat shader's viewport uniform in sync with the canvas size; it's
// needed to convert projected covariance into pixel-space gl_PointSize.
function updateViewportUniform() {
  const material = state.currentMesh?.material;
  if (material?.uniforms?.viewport) {
    const canvas = state.renderer.domElement;
    material.uniforms.viewport.value.set(canvas.width, canvas.height);
  }
}

// Render only when needed (orbit interaction or damping tail) to keep a >1M
// splat scene responsive instead of redrawing every frame.
let continuousRenderId = null;
function startContinuousRender() {
  if (continuousRenderId) return;
  const loop = () => {
    continuousRenderId = requestAnimationFrame(loop);
    state.controls.update();
    if (state.currentMesh?.update) {
      state.currentMesh.update();
    }
    state.renderer.render(state.scene, state.camera);
  };
  continuousRenderId = requestAnimationFrame(loop);
}
function stopContinuousRender() {
  if (continuousRenderId) {
    cancelAnimationFrame(continuousRenderId);
    continuousRenderId = null;
  }
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    state.controls.update();
    // GaussianSplats3D needs a per-frame update() for splat sorting.
    if (state.currentMesh?.update) {
      state.currentMesh.update();
    }
    state.renderer.render(state.scene, state.camera);
    // Keep the damping tail animating until controls settle.
    startAnimation();
  });
}

function animate() {
  // controls.update() returns true while damping is still settling; keep
  // rendering until it stops, then the loop idles at ~zero cost.
  if (state.controls.update()) {
    state.renderer.render(state.scene, state.camera);
    requestAnimationFrame(animate);
  }
}

function startAnimation() {
  requestAnimationFrame(animate);
}

function disposeCurrentMesh() {
  stopContinuousRender();
  const m = state.currentMesh;
  if (m) {
    // GaussianSplats3D Viewer: dispose its resources; for regular meshes,
    // remove from scene and dispose geometry/material.
    if (m.dispose) {
      m.dispose();
    } else {
      state.scene.remove(m);
      m.geometry?.dispose();
      m.material?.dispose();
    }
    state.currentMesh = null;
  }
}

// ---------------------------------------------------------------------------
// PLY parsing (3DGS-aware)
// ---------------------------------------------------------------------------
// Three.js's PLYLoader ignores 3DGS-specific properties (f_dc_*, opacity,
// scale_*, rot_*), so a SHARP output renders as a near-invisible uncolored
// point cloud. This parser reads the binary vertex block directly and converts
// the spherical-harmonics DC coefficients into RGB plus opacity into alpha.
const SH_C0 = 0.28209479177387814; // 1/(2*sqrt(pi))

function buildGeometryFromPly(buffer) {
  const bytes = new Uint8Array(buffer);
  // Parse the ASCII header up to "end_header".
  let offset = 0;
  const decoder = new TextDecoder("ascii");
  const headerLines = [];
  while (offset < bytes.length) {
    const nl = bytes.indexOf(10, offset); // '\n'
    const lineBytes = nl === -1 ? bytes.slice(offset) : bytes.slice(offset, nl);
    const line = decoder.decode(lineBytes).replace(/\r$/, "");
    offset = nl === -1 ? bytes.length : nl + 1;
    headerLines.push(line);
    if (line.trim() === "end_header") break;
  }

  // Collect vertex property names + types in declaration order.
  let inVertex = false;
  const props = [];
  const propTypes = [];
  let vertexCount = 0;
  let isBinary = false;
  let littleEndian = true;
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("format")) {
      isBinary = trimmed.includes("binary");
      littleEndian = trimmed.includes("little_endian");
    } else if (trimmed.startsWith("element vertex ")) {
      inVertex = true;
      vertexCount = parseInt(trimmed.split(/\s+/)[2], 10);
    } else if (trimmed.startsWith("element ")) {
      inVertex = false; // extrinsic/intrinsic/frame/etc.
    } else if (trimmed.startsWith("property") && inVertex) {
      const parts = trimmed.split(/\s+/);
      propTypes.push(parts[1]);
      props.push(parts[parts.length - 1]);
    }
  }

  const is3dgs =
    props.includes("f_dc_0") && props.includes("f_dc_1") && props.includes("f_dc_2");

  // Only the binary 3DGS path is handled here; ASCII / non-3DGS PLYs fall back
  // to Three.js's PLYLoader.
  if (!isBinary || !is3dgs) return null;

  const propIndex = {};
  props.forEach((p, i) => (propIndex[p] = i));
  const stride = props.length * 4; // SHARP writes all vertex props as float32
  const view = new DataView(buffer, offset);

  // First pass: count visible splats (alpha above threshold) so we can drop the
  // ~35% near-transparent gaussians that only waste fill rate.
  const alphaThreshold = 0.05;
  let visibleCount = 0;
  const alphas = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const base = i * stride;
    let alpha = 1;
    if ("opacity" in propIndex) {
      const o = view.getFloat32(base + propIndex["opacity"] * 4, littleEndian);
      alpha = 1 / (1 + Math.exp(-o));
    }
    alphas[i] = alpha;
    if (alpha > alphaThreshold) visibleCount++;
  }

  // Cap the number of rendered splats. SHARP outputs ~1M gaussians; on the
  // discrete GPU 500k renders smoothly. Stride-sampling keeps a representative
  // subset so the subject stays dense.
  // Cap splats so the cloud renders without crashing the WebGL context on the
  // integrated GPU. With the discrete GPU (powerPreference + Windows GPU
  // preference), all splats render; lower this only if the iGPU is still in use.
  const MAX_SPLATS = Infinity;
  const strideSample = visibleCount > MAX_SPLATS ? Math.ceil(visibleCount / MAX_SPLATS) : 1;
  const renderCount = Math.ceil(visibleCount / strideSample);

  const positions = new Float32Array(renderCount * 3);
  const colors = new Float32Array(renderCount * 3);
  const alphaAttr = new Float32Array(renderCount);
  // Per-splat 3D covariance (xx,yy,zz,xy in covA; xz,yz in covB) for true
  // gaussian-splat rendering: each splat becomes an elliptical billboard sized
  // by its scale+rotation, not a uniform round point.
  const covA = new Float32Array(renderCount * 4);
  const covB = new Float32Array(renderCount * 2);
  let out = 0;
  let visibleSeen = 0;

  for (let i = 0; i < vertexCount; i++) {
    if (alphas[i] <= alphaThreshold) continue;
    // Keep every strideSample-th visible splat to respect the cap.
    if (visibleSeen % strideSample !== 0) {
      visibleSeen++;
      continue;
    }
    visibleSeen++;
    const base = i * stride;
    // SHARP writes OpenCV camera coords (x-right, y-down, z-forward). Three.js
    // expects y-up. The user wants the view flipped horizontally 180deg and
    // rotated 180deg, which combined is y->-y, z->-z. Apply it here so the
    // framing/orbit math works on corrected coordinates.
    positions[out * 3] = view.getFloat32(base + propIndex["x"] * 4, littleEndian);
    positions[out * 3 + 1] = -view.getFloat32(base + propIndex["y"] * 4, littleEndian);
    positions[out * 3 + 2] = -view.getFloat32(base + propIndex["z"] * 4, littleEndian);

    // SH DC -> linear RGB: 0.5 + SH_C0 * f_dc
    const r = 0.5 + SH_C0 * view.getFloat32(base + propIndex["f_dc_0"] * 4, littleEndian);
    const g = 0.5 + SH_C0 * view.getFloat32(base + propIndex["f_dc_1"] * 4, littleEndian);
    const b = 0.5 + SH_C0 * view.getFloat32(base + propIndex["f_dc_2"] * 4, littleEndian);
    const alpha = alphas[i];
    alphaAttr[out] = alpha;
    // Keep full color; opacity is applied in the fragment shader via vAlpha.
    colors[out * 3] = clamp01(r);
    colors[out * 3 + 1] = clamp01(g);
    colors[out * 3 + 2] = clamp01(b);

    // 3D covariance = R * diag(s0^2,s1^2,s2^2) * R^T from scale (exp) and
    // rotation quaternion (w,x,y,z). Normalize the quaternion first — SHARP
    // doesn't guarantee unit quaternions.
    const s0 = Math.exp(view.getFloat32(base + propIndex["scale_0"] * 4, littleEndian));
    const s1 = Math.exp(view.getFloat32(base + propIndex["scale_1"] * 4, littleEndian));
    const s2 = Math.exp(view.getFloat32(base + propIndex["scale_2"] * 4, littleEndian));
    let qw = view.getFloat32(base + propIndex["rot_0"] * 4, littleEndian);
    let qx = view.getFloat32(base + propIndex["rot_1"] * 4, littleEndian);
    let qy = view.getFloat32(base + propIndex["rot_2"] * 4, littleEndian);
    let qz = view.getFloat32(base + propIndex["rot_3"] * 4, littleEndian);
    const qn = Math.hypot(qw, qx, qy, qz) || 1.0;
    qw /= qn; qx /= qn; qy /= qn; qz /= qn;
    const r00 = 1 - 2 * (qy * qy + qz * qz);
    const r01 = 2 * (qx * qy - qz * qw);
    const r02 = 2 * (qx * qz + qy * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    const r22 = 1 - 2 * (qx * qx + qy * qy);
    const s0s0 = s0 * s0, s1s1 = s1 * s1, s2s2 = s2 * s2;
    covA[out * 4] = r00 * r00 * s0s0 + r01 * r01 * s1s1 + r02 * r02 * s2s2;       // xx
    covA[out * 4 + 1] = r11 * r11 * s1s1 + r01 * r01 * s0s0 + r12 * r12 * s2s2;   // yy
    covA[out * 4 + 2] = r22 * r22 * s2s2 + r02 * r02 * s0s0 + r12 * r12 * s1s1;   // zz
    covA[out * 4 + 3] = r00 * r01 * s0s0 + r01 * r11 * s1s1 + r02 * r12 * s2s2;   // xy
    covB[out * 2] = r00 * r02 * s0s0 + r01 * r12 * s1s1 + r02 * r22 * s2s2;       // xz
    covB[out * 2 + 1] = r11 * r12 * s1s1 + r01 * r02 * s0s0 + r12 * r22 * s2s2;   // yz
    out++;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("alpha", new THREE.BufferAttribute(alphaAttr, 1));
  geometry.setAttribute("cov3dA", new THREE.BufferAttribute(covA, 4));
  geometry.setAttribute("cov3dB", new THREE.BufferAttribute(covB, 2));
  geometry.userData.is3dgs = true;
  geometry.userData.splatCount = renderCount;
  return geometry;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Frame a loaded GaussianSplats3D scene: center it at the origin and set the
// camera distance so the bounding box fills the view.
function frameSplatBox(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // Re-center the splat group at the origin for orbiting.
  if (state.currentMesh) {
    state.currentMesh.position.sub(center);
  }
  const fov = state.camera.fov * Math.PI / 180;
  const aspect = state.camera.aspect || 1;
  const distForH = size.y / (2 * Math.tan(fov / 2));
  const distForW = size.x / (2 * Math.tan(fov / 2) * aspect);
  const fitDist = Math.max(distForH, distForW) * 1.2;
  state.camera.position.set(0, 0, fitDist);
  state.camera.near = Math.max(fitDist * 0.001, 0.1);
  state.camera.far = Math.max(fitDist, size.z) * 50 + 1000;
  state.camera.updateProjectionMatrix();
  state.controls.target.set(0, 0, 0);
  state.controls.update();
  showViewerOverlay(
    `3DGS · ${Math.round(size.x * 100) / 100} × ${Math.round(size.y * 100) / 100} × ${Math.round(size.z * 100) / 100}`
  );
}

// True gaussian-splat material: each splat is a screen-space elliptical
// billboard whose size/shape comes from the projected 3D covariance (scale +
// rotation), with a gaussian alpha falloff so overlapping splats blend into a
// continuous smooth surface. This is real 3DGS rendering, not a point cloud.
function createSplatMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    uniforms: {
      viewport: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float alpha;
      attribute vec4 cov3dA;   // xx, yy, zz, xy
      attribute vec2 cov3dB;   // xz, yz
      uniform vec2 viewport;
      varying vec3 vColor;
      varying float vAlpha;
      varying vec2 vCov2D;     // (a, c) diagonal
      varying float vCov2D_b;  // off-diagonal
      varying float vRadius;
      void main() {
        vColor = color;
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;

        float z = -mv.z;
        if (z <= 0.0001) {
          gl_PointSize = 0.0;
          return;
        }

        float sxx = cov3dA.x, syy = cov3dA.y, szz = cov3dA.z;
        float sxy = cov3dA.w, sxz = cov3dB.x, syz = cov3dB.y;
        sxx = clamp(sxx, 0.0, 4.0);
        syy = clamp(syy, 0.0, 4.0);
        szz = clamp(szz, 0.0, 4.0);

        // Project covariance to screen space using the viewport so the result
        // is in pixel units (gl_PointSize is pixels).
        float fx = projectionMatrix[0][0] * viewport.x * 0.5;
        float fy = projectionMatrix[1][1] * viewport.y * 0.5;
        float j0 = fx / z, j2 = -fx * mv.x / (z * z);
        float k1 = fy / z, k2 = -fy * mv.y / (z * z);
        float a = j0 * (j0 * sxx + j2 * sxz) + j2 * (j0 * sxz + j2 * szz);
        float b = k1 * (j0 * sxy + j2 * syz) + k2 * (j0 * sxz + j2 * szz);
        float c = k1 * (k1 * syy + k2 * syz) + k2 * (k1 * syz + k2 * szz);
        a += 0.3;
        c += 0.3;

        float mid = 0.5 * (a + c);
        float disc = sqrt(max(0.25 * (a - c) * (a - c) + b * b, 0.0));
        float lambdaMax = max(mid + disc, 0.01);
        float radius = 3.0 * sqrt(lambdaMax);
        radius = clamp(radius, 1.5, 96.0);

        vCov2D = vec2(a, c);
        vCov2D_b = b;
        vRadius = radius;
        gl_PointSize = radius * 2.0;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying float vAlpha;
      varying vec2 vCov2D;
      varying float vCov2D_b;
      varying float vRadius;
      void main() {
        // Convert gl_PointCoord to a pixel-space offset from the splat center.
        vec2 d = (gl_PointCoord * 2.0 - 1.0) * vRadius;
        float a = vCov2D.x, b = vCov2D_b, c = vCov2D.y;
        float det = a * c - b * b;
        if (det <= 0.0) discard;
        float m2 = (c * d.x * d.x - 2.0 * b * d.x * d.y + a * d.y * d.y) / det;
        float alpha = vAlpha * exp(-0.5 * m2);
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
  });
}

// Compute a bounding box of the cloud's dense core, ignoring outlier points.
// SHARP scenes are often elongated (e.g. a 400-unit z trail) with a dense
// subject in a small fraction of that span. The full bbox would leave the
// subject as a dot, so we use the interquartile range (25-75th percentile)
// as the subject extent and frame around that.
function computeRobustFrame(geometry) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const sample = Math.min(count, 50000);
  const step = Math.max(1, Math.floor(count / sample));
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < count; i += step) {
    xs.push(pos.getX(i));
    ys.push(pos.getY(i));
    zs.push(pos.getZ(i));
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const lo = (arr) => arr[Math.floor(arr.length * 0.25)];
  const hi = (arr) => arr[Math.floor(arr.length * 0.75)];
  const minX = lo(xs), maxX = hi(xs);
  const minY = lo(ys), maxY = hi(ys);
  const minZ = lo(zs), maxZ = hi(zs);
  const center = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );
  // Inflate the IQR span by 2x so we frame the subject, not just its middle
  // quartile (IQR covers 50% of points; 2x covers most of the subject).
  const size = new THREE.Vector3(
    Math.max((maxX - minX) * 2, 0.1),
    Math.max((maxY - minY) * 2, 0.1),
    Math.max((maxZ - minZ) * 2, 0.1)
  );
  return { center, size };
}

async function loadPly(path) {
  showViewerOverlay("Loading PLY…");
  try {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    // buildGeometryFromPly handles binary 3DGS PLYs (SHARP output); everything
    // else (ASCII, mesh PLYs) falls back to Three.js's PLYLoader.
    disposeCurrentMesh();

    const is3dgsBinary = (function () {
      // Quick header sniff: 3DGS PLYs have f_dc_* properties. We only need to
      // know whether to route to GaussianSplats3D (URL-based) vs our parser.
      const bytes = new Uint8Array(buffer);
      const head = new TextDecoder("ascii").decode(bytes.slice(0, 2048));
      return head.includes("f_dc_0") && head.includes("end_header");
    })();

    let geometry = null;
    let frame = null;
    if (!is3dgsBinary) {
      geometry = buildGeometryFromPly(buffer);
      if (geometry === null) {
        const loader = new PLYLoader();
        geometry = loader.parse(buffer);
      }
      frame = computeRobustFrame(geometry);
    }

    // 3DGS PLYs render through GaussianSplats3D (DropInViewer): a mature
    // renderer with proper splat sorting, alpha blending, and EWA projection.
    // Non-3DGS PLYs fall back to our Three.js point/mesh rendering.
    const is3dgs = is3dgsBinary;
    const hasIndex = geometry ? geometry.index !== null : false;
    const maxDim = frame ? Math.max(frame.size.x, frame.size.y, frame.size.z) || 1 : 10;

    if (is3dgs) {
      // GaussianSplats3D Viewer in self-driven mode: it manages its own render
      // loop, controls, and renderer on the canvas element. This is the
      // documented simple path and avoids the integration stalls that happen
      // when handing it an external renderer.
      const canvas = $("viewerCanvas");
      const wrap = canvas.parentElement;
      const gsViewer = new Viewer({
        selfDrivenMode: true,
        useBuiltInControls: true,
        sharedMemoryForWorkers: false,
        gpuAcceleratedSort: false,
        splatAlphaRemovalThreshold: 5,
        rootElement: wrap,
        cameraUp: [0, 1, 0],
      });
      state.currentMesh = gsViewer;
      state.gsViewer = gsViewer;
      window.__gsViewer = gsViewer; // debug hook
      showViewerOverlay("Loading 3DGS via GaussianSplats3D…");
      try {
        await gsViewer.addSplatScene(`/api/ply-vertex-only?path=${encodeURIComponent(path)}`, {
          showLoadingUI: false,
        });
        // Start the self-driven render loop (sorting + drawing) now that the
        // splat scene is loaded.
        gsViewer.start();
        showViewerOverlay("3DGS loaded");
      } catch (err) {
        showViewerOverlay("Failed to load 3DGS");
        showError(err.message || String(err));
      }
      return;
    }

    let mesh;
    if (hasIndex) {
      mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0x0f766e,
          vertexColors: geometry.attributes.color !== undefined,
          side: THREE.DoubleSide,
          flatShading: true,
        })
      );
    } else {
      const pointSize = Math.max(maxDim * 0.003, 0.005);
      mesh = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: pointSize,
          vertexColors: geometry.attributes.color !== undefined,
          color: geometry.attributes.color !== undefined ? 0xffffff : 0x0f766e,
          sizeAttenuation: true,
          transparent: false,
          depthWrite: true,
        })
      );
    }

    const { center, size } = frame;
    // Re-center the subject at the origin so OrbitControls rotates around it.
    mesh.position.sub(center);
    state.scene.add(mesh);
    state.currentMesh = mesh;

    // Frame the subject to fill the view. The camera looks down +z, so the
    // visible extent is the x/y plane; distance is set to fit the larger of the
    // two (accounting for aspect ratio), not the depth axis. For an elongated
    // SHARP scene this keeps the subject large instead of fitting the long z
    // tail into a tiny view.
    const fov = state.camera.fov * Math.PI / 180;
    const aspect = state.camera.aspect || 1;
    // Fit the larger screen dimension: if aspect > 1 (wide), y is the limit;
    // otherwise x is. Use the max of x/y extent scaled to fill.
    const visibleH = size.y;
    const visibleW = size.x;
    const distForH = visibleH / (2 * Math.tan(fov / 2));
    const distForW = visibleW / (2 * Math.tan(fov / 2) * aspect);
    const fitDist = Math.max(distForH, distForW) * 1.2;
    state.camera.position.set(0, 0, fitDist);
    // Wide near/far so the whole elongated scene stays visible when orbiting
    // and zooming; SHARP scenes span a large z range.
    state.camera.near = Math.max(fitDist * 0.001, 0.1);
    state.camera.far = Math.max(fitDist, size.z) * 50 + 1000;
    state.camera.updateProjectionMatrix();
    state.controls.target.set(0, 0, 0);
    state.controls.update();
    requestRender();

    const kind = is3dgs ? "3DGS" : hasIndex ? "mesh" : "points";
    showViewerOverlay(
      `${kind} · ${geometry.attributes.position.count} pts · ${Math.round(size.x * 100) / 100} × ${Math.round(size.y * 100) / 100} × ${Math.round(size.z * 100) / 100}`
    );
  } catch (err) {
    showViewerOverlay("Failed to load PLY");
    showError(err.message || String(err));
  }
}

function showViewerOverlay(text) {
  $("viewerOverlay").textContent = text;
}

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

async function refreshPlyFiles() {
  const data = await api("/api/ply-files");
  const sel = $("plySelect");
  sel.innerHTML = data.files
    .map((file) => `<option value="${file.path}">${file.name}</option>`)
    .join("");
  if (data.files.length) {
    await loadPly(data.files[0].path);
  } else {
    showViewerOverlay("No .ply files in inputs/");
  }
}

// ---------------------------------------------------------------------------
// Screenshot + repair
// ---------------------------------------------------------------------------
async function captureAndRepair() {
  if (!state.currentMesh) {
    showError("Load a PLY first, then capture a view.");
    return;
  }
  hideError();
  setBusy(true);

  // Render immediately before reading the buffer so the screenshot reflects the
  // exact current camera angle.
  state.renderer.render(state.scene, state.camera);
  const screenshot = state.renderer.domElement.toDataURL("image/png");

  const payload = {
    screenshot,
    prompt: $("prompt").value,
    steps: Number($("steps").value) || 4,
    megapixels: Number($("megapixels").value) || 1,
  };
  const seed = Number($("seed").value);
  if (Number.isFinite(seed) && seed > 0) {
    payload.seed = Math.floor(seed);
  }

  try {
    const data = await api("/api/repair-screenshot", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    $("screenshotImg").src = `${data.screenshot_url}&t=${Date.now()}`;
    $("repairImg").src = `${data.repair_url}&t=${Date.now()}`;
    $("outputSection").style.display = "grid";
    $("outputMeta").textContent = `${data.repair_path}`;
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  const btn = $("captureBtn");
  btn.disabled = busy;
  btn.textContent = busy ? "补全中…" : "截图并补全";
  $("spinner").classList.toggle("show", busy);
}

function showError(msg) {
  const el = $("alert");
  el.textContent = msg;
  el.style.display = "block";
}

function hideError() {
  $("alert").style.display = "none";
}

// ---------------------------------------------------------------------------
// Photo upload -> SHARP predict -> load PLY
// ---------------------------------------------------------------------------
const photoState = {
  file: null,
  dataUrl: null,
  name: null,
  jobId: null,
  pollTimer: null,
};

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function onPhotoSelected(file) {
  photoState.file = file;
  photoState.name = file.name;
  photoState.dataUrl = await readAsDataURL(file);
  $("photoPreview").src = photoState.dataUrl;
  $("photoPreview").style.display = "block";
  $("generatePlyBtn").disabled = false;
  hideSharpError();
  $("sharpLog").style.display = "none";
}

async function generatePly() {
  if (!photoState.dataUrl) return;
  hideSharpError();
  $("generatePlyBtn").disabled = true;
  $("generatePlyBtn").textContent = "生成中…";
  $("sharpSpinner").classList.add("show");
  $("sharpLog").textContent = "";
  $("sharpLog").style.display = "block";

  try {
    const data = await api("/api/sharp/generate", {
      method: "POST",
      body: JSON.stringify({ imageData: photoState.dataUrl, imageName: photoState.name }),
    });
    photoState.jobId = data.job_id;
    pollSharpStatus();
  } catch (err) {
    showSharpError(err.message || String(err));
    resetGenerateBtn();
  }
}

function pollSharpStatus() {
  if (photoState.pollTimer) clearTimeout(photoState.pollTimer);
  const tick = async () => {
    try {
      const status = await api(`/api/sharp/status?job_id=${encodeURIComponent(photoState.jobId)}`);
      if (status.log) {
        $("sharpLog").textContent = status.log.slice(-4000);
        $("sharpLog").scrollTop = $("sharpLog").scrollHeight;
      }
      if (status.state === "done" && status.ply_url) {
        $("sharpSpinner").classList.remove("show");
        resetGenerateBtn();
        // Load the freshly generated PLY into the viewer and refresh the list.
        await loadPly(status.ply_path);
        await refreshPlyFiles();
        return;
      }
      if (status.state === "failed") {
        $("sharpSpinner").classList.remove("show");
        resetGenerateBtn();
        showSharpError(status.error || "sharp predict failed.");
        return;
      }
      photoState.pollTimer = setTimeout(tick, 2000);
    } catch (err) {
      showSharpError(err.message || String(err));
      $("sharpSpinner").classList.remove("show");
      resetGenerateBtn();
    }
  };
  tick();
}

function resetGenerateBtn() {
  $("generatePlyBtn").disabled = !photoState.dataUrl;
  $("generatePlyBtn").textContent = "生成 PLY";
}

function showSharpError(msg) {
  const el = $("sharpAlert");
  el.textContent = msg;
  el.style.display = "block";
}

function hideSharpError() {
  $("sharpAlert").style.display = "none";
}

// ---------------------------------------------------------------------------
// ComfyUI status polling
// ---------------------------------------------------------------------------
async function refreshComfyuiStatus() {
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
// Wire up the UI
// ---------------------------------------------------------------------------
async function init() {
  initViewer();
  try {
    await api("/api/health");
    $("healthDot").classList.add("ready");
  } catch {
    $("healthDot").classList.remove("ready");
  }

  await refreshPlyFiles();
  refreshComfyuiStatus();
  setInterval(refreshComfyuiStatus, 15000);

  $("plySelect").addEventListener("change", (e) => {
    if (e.target.value) loadPly(e.target.value);
  });
  $("captureBtn").addEventListener("click", () => captureAndRepair().catch((err) => showError(err.message)));
  $("randomSeedBtn").addEventListener("click", () => {
    $("seed").value = Math.floor(Math.random() * 2 ** 31);
  });

  $("photoInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) onPhotoSelected(file).catch((err) => showSharpError(err.message));
  });
  $("generatePlyBtn").addEventListener("click", () => generatePly().catch((err) => showSharpError(err.message)));
}

init().catch((err) => showError(err.message || String(err)));
