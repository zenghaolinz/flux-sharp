// Flux Sharp — Photo → SHARP 3DGS → 3D Preview → Screenshot → ComfyUI Repair
//
// Flow:
//   1. Upload photo
//   2. SHARP generates PLY from photo
//   3. PLY loaded in GaussianSplats3D viewer (user adjusts camera)
//   4. Screenshot current view → send to ComfyUI for repair
//   5. Compare (original photo vs repair) / Export repair result

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
  photoDataUrl: null,   // uploaded photo data URL, loaded lazily for ComfyUI payloads
  photoUrl: null,       // persisted photo URL served by backend gallery
  photoPath: null,      // persisted photo path relative to workspace
  photoName: null,      // original filename
  plyPath: null,        // generated PLY path from SHARP
  plyUrl: null,         // PLY URL for loading into viewer
  viewer: null,         // GaussianSplats3D Viewer instance
  disposePromise: null,  // pending viewer disposal promise
  screenshotUrl: null,  // latest raw 3D canvas screenshot URL returned by backend
  screenshotPath: null, // latest raw 3D screenshot path; persisted for gallery
  repairUrl: null,      // repair result URL
  repairPath: null,     // repair result path; persisted for gallery
  comparing: false,     // true = showing original photo, false = showing repair
  inRepairView: false,  // true = repair result/original comparison image overlays canvas
  galleryItems: [],     // uploaded photos persisted on backend and restored on reload
  currentItemId: null,  // selected gallery item id
  initialCameraPos: null,   // THREE.Vector3 — camera position at initial view
  initialCameraQuat: null,  // THREE.Quaternion — camera orientation at initial view
  generationToken: 0,      // increments to invalidate stale async generate jobs
  repairToken: 0,          // increments to invalidate stale async repair jobs
  isGenerating: false,     // true while SHARP/3DGS generation is running
  isRepairing: false,      // true while ComfyUI reconstruction is running
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

function setDockActive(section) {
  $("uploadAction")?.classList.toggle("active", section === "upload");
  $("galleryBtn")?.classList.toggle("active", section === "gallery");
}

function setFrameEffect(effect, enabled) {
  const frame = $("frame");
  if (!frame) return;
  if (effect === "generate") {
    frame.classList.toggle("is-generating", enabled);
  }
  if (effect === "reconstruct") {
    frame.classList.toggle("is-reconstructing", enabled);
  }
}

function setActionText(buttonId, text) {
  const textEl = $(buttonId)?.querySelector(".action-text");
  if (textEl) textEl.textContent = text;
}

function resetFrameEffects() {
  setFrameEffect("generate", false);
  setFrameEffect("reconstruct", false);
}

function assertFresh(tokenName, token) {
  if (state[tokenName] !== token) {
    throw new Error("__STALE_ASYNC_RESULT__");
  }
}

async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取图片失败: HTTP ${res.status}`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageSizeFromSrc(src) {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = src;
  });
}


function tunePreviewControls(viewer = state.viewer) {
  if (!viewer) return;

  // The default GaussianSplats3D / OrbitControls drag speed feels too jumpy
  // for fine camera-angle reconstruction. Keep every mouse operation slower
  // and more damped so users can accurately choose the target view.
  const controlsList = [
    viewer.controls,
    viewer.perspectiveControls,
    viewer.orthographicControls,
  ].filter(Boolean);

  for (const controls of controlsList) {
    controls.rotateSpeed = 0.22;
    controls.panSpeed = 0.42;
    controls.zoomSpeed = 0.55;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.keyPanSpeed = 4;
    if (typeof controls.update === "function") controls.update();
  }
}

function setPreviewLocked(locked) {
  const frame = $("frame");
  const container = $("canvasContainer");
  frame?.classList.toggle("is-preview-locked", locked);
  container?.classList.toggle("locked", locked);
  if (state.viewer?.controls && "enabled" in state.viewer.controls) {
    state.viewer.controls.enabled = !locked;
    if (!locked && typeof state.viewer.controls.update === "function") {
      state.viewer.controls.update();
    }
  }
}

function blockIfRepairing(actionText = "重构正在进行，请等待完成") {
  if (!state.isRepairing) return false;
  showError(actionText);
  return true;
}

function mergeBackendPhotoItem(localItem = {}, persisted = {}) {
  const merged = mergePersistedItem(localItem, persisted);
  merged.photoHash = persisted.photo_hash ?? localItem.photoHash ?? null;
  return merged;
}

function photoSrc(item = getCurrentItem()) {
  if (!item) return state.photoDataUrl || state.photoUrl || "";
  return item.photoDataUrl || item.photoUrl || "";
}

function dedupeGalleryItems(items) {
  // Duplicate uploads are now allowed intentionally. Keep every gallery item.
  return (items || []).filter(Boolean);
}

async function ensurePhotoDataUrl(item = getCurrentItem()) {
  if (!item) {
    if (state.photoDataUrl) return state.photoDataUrl;
    if (state.photoUrl) {
      state.photoDataUrl = await urlToDataUrl(state.photoUrl);
      return state.photoDataUrl;
    }
    throw new Error("原图未加载");
  }
  if (item.photoDataUrl) return item.photoDataUrl;
  if (!item.photoUrl) throw new Error("图库原图文件不存在");
  item.photoDataUrl = await urlToDataUrl(item.photoUrl);
  if (item.id === state.currentItemId) state.photoDataUrl = item.photoDataUrl;
  return item.photoDataUrl;
}

function mergePersistedItem(localItem, persisted) {
  if (!persisted) return localItem;
  const mapped = {
    id: persisted.id,
    photoName: persisted.photo_name ?? localItem.photoName,
    photoWidth: persisted.photo_width ?? localItem.photoWidth,
    photoHeight: persisted.photo_height ?? localItem.photoHeight,
    photoPath: persisted.photo_path ?? localItem.photoPath ?? null,
    photoUrl: persisted.photo_url ?? localItem.photoUrl ?? null,
    photoDataUrl: localItem.photoDataUrl ?? null,
    plyPath: localItem.plyPath ?? null,
    plyUrl: localItem.plyUrl ?? null,
    screenshotPath: localItem.screenshotPath ?? null,
    screenshotUrl: localItem.screenshotUrl ?? null,
    repairPath: localItem.repairPath ?? null,
    repairUrl: localItem.repairUrl ?? null,
    createdAt: persisted.created_at ?? localItem.createdAt ?? Date.now() / 1000,
    updatedAt: persisted.updated_at ?? localItem.updatedAt ?? Date.now() / 1000,
    photoHash: persisted.photo_hash ?? localItem.photoHash ?? null,
  };
  return mapped;
}

async function persistItem(item = getCurrentItem(), { includePhoto = false } = {}) {
  if (!item) return null;
  const payload = {
    id: item.id,
    photoName: item.photoName,
    photoWidth: item.photoWidth,
    photoHeight: item.photoHeight,
  };
  if (includePhoto && item.photoDataUrl && !item.photoPath) {
    payload.photoDataUrl = item.photoDataUrl;
  }
  const data = await api("/api/gallery/upsert", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const merged = mergeBackendPhotoItem(item, data.item);
  Object.assign(item, merged);
  if (item.id === state.currentItemId) applyItemToState(item, { keepView: true });
  return item;
}

async function loadPersistentGallery() {
  const data = await api("/api/gallery");
  state.galleryItems = dedupeGalleryItems((data.items || []).map((it) => mergeBackendPhotoItem({}, it)));
  if (state.galleryItems.length && !state.currentItemId) {
    state.currentItemId = state.galleryItems[0].id;
    applyPhotoToFrame(state.galleryItems[0]);
    setDockActive("gallery");
  }
  renderGallery();
}

function applyItemToState(item, { keepView = false } = {}) {
  state.photoWidth = item.photoWidth;
  state.photoHeight = item.photoHeight;
  state.photoDataUrl = item.photoDataUrl || null;
  state.photoUrl = item.photoUrl || null;
  state.photoPath = item.photoPath || null;
  state.photoName = item.photoName;
  state.plyPath = item.plyPath || null;
  state.plyUrl = item.plyUrl || null;
  state.screenshotPath = item.screenshotPath || null;
  state.screenshotUrl = item.screenshotUrl || null;
  state.repairPath = item.repairPath || null;
  state.repairUrl = item.repairUrl || null;
  if (!keepView) {
    state.comparing = false;
    state.inRepairView = false;
  }
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

  // Leave room for the top bar and bottom glass controls.
  const maxW = Math.min(pw * 0.72, 1120);
  const maxH = Math.min(ph * 0.66, ph - 220);

  let frameW, frameH;
  if (photoRatio > maxW / maxH) {
    frameW = maxW;
    frameH = maxW / photoRatio;
  } else {
    frameH = maxH;
    frameW = maxH * photoRatio;
  }

  const frame = $("frame");
  const appliedFrameW = Math.max(280, frameW);
  const appliedFrameH = Math.max(180, frameH);
  frame.style.width = appliedFrameW + "px";
  frame.style.height = appliedFrameH + "px";

  // Update camera aspect ratio so 3D content isn't stretched.
  if (state.viewer && state.viewer.camera) {
    state.viewer.camera.aspect = appliedFrameW / appliedFrameH;
    state.viewer.camera.updateProjectionMatrix();
  }
}


// ---------------------------------------------------------------------------
// Gallery state: each uploaded photo becomes a selectable work item.
// Items are kept in memory for the current browser session.
// ---------------------------------------------------------------------------
function getCurrentItem() {
  return state.galleryItems.find((item) => item.id === state.currentItemId) || null;
}

function saveCurrentItem() {
  const item = getCurrentItem();
  if (!item) return;
  item.photoWidth = state.photoWidth;
  item.photoHeight = state.photoHeight;
  item.photoDataUrl = state.photoDataUrl;
  item.photoUrl = state.photoUrl;
  item.photoPath = state.photoPath;
  item.photoName = state.photoName;
  item.plyPath = state.plyPath;
  item.plyUrl = state.plyUrl;
  item.screenshotUrl = state.screenshotUrl;
  item.screenshotPath = state.screenshotPath;
  item.repairUrl = state.repairUrl;
  item.repairPath = state.repairPath;
}

function itemStage(item) {
  return "原图";
}

function renderGallery() {
  const grid = $("galleryGrid");
  if (!grid) return;

  if (!state.galleryItems.length) {
    grid.innerHTML = `<div class="gallery-empty">还没有上传照片</div>`;
    return;
  }

  grid.innerHTML = state.galleryItems.map((item) => `
    <button class="gallery-card ${item.id === state.currentItemId ? "active" : ""}" type="button" data-id="${item.id}">
      <img src="${photoSrc(item)}" alt="${item.photoName || "photo"}" />
      <span class="gallery-meta">
        <span class="gallery-name">${item.photoName || "未命名照片"}</span>
        <span class="gallery-state">${itemStage(item)}</span>
      </span>
    </button>
  `).join("");

  grid.querySelectorAll(".gallery-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectGalleryItem(card.dataset.id).catch((err) => showError(err.message || String(err)));
      // Keep the gallery open so users can switch between images without reopening it.
    });
  });
}

function toggleGalleryPanel(force) {
  const panel = $("galleryPanel");
  if (!panel) return;
  renderGallery();
  const shouldShow = typeof force === "boolean" ? force : panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !shouldShow);
  setDockActive("gallery");
}

async function persistCurrentItem() {
  const item = getCurrentItem();
  if (!item?.id) return;
  const payload = {
    id: item.id,
    photoName: item.photoName,
    photoWidth: item.photoWidth,
    photoHeight: item.photoHeight,
    photoPath: item.photoPath,
  };
  const data = await api('/api/gallery/update', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const normalized = mergeBackendPhotoItem(item, data.item);
  const idx = state.galleryItems.findIndex((it) => it.id === normalized.id);
  if (idx >= 0) state.galleryItems[idx] = { ...state.galleryItems[idx], ...normalized };
  if (state.currentItemId === normalized.id) {
    const current = getCurrentItem();
    if (current) Object.assign(current, normalized);
    state.photoPath = normalized.photoPath || state.photoPath;
    state.photoUrl = normalized.photoUrl || state.photoUrl;
    state.photoName = normalized.photoName || state.photoName;
    state.photoWidth = normalized.photoWidth || state.photoWidth;
    state.photoHeight = normalized.photoHeight || state.photoHeight;
  }
  renderGallery();
}

function applyPhotoToFrame(item) {
  applyItemToState(item);

  const src = photoSrc(item);
  const frame = $("frame");
  frame.classList.add("active");
  frame.style.backgroundImage = src ? `url("${src}")` : "none";
  updateFrameSize();

  $("uploadPrompt").classList.add("hidden");
  $("previewCloseBtn")?.classList.remove("hidden");
  $("canvasContainer").classList.remove("active");
  const img = $("previewImg");
  img.src = item.repairUrl ? `${item.repairUrl}&t=${Date.now()}` : src;
  img.classList.add("visible");

  $("postGroup").classList.toggle("hidden", !item.repairUrl);
  $("compareBtn").classList.remove("active");
  $("restoreBtn").textContent = "恢复3D";
  showModeBadge(item.repairUrl ? "重构结果" : "");
  showViewHint(false);

  if (item.repairUrl) {
    $("generateBtn").classList.add("hidden");
    $("repairBtn").classList.remove("hidden");
    $("repairBtn").disabled = false;
    setActionText("repairBtn", "重构");
    state.inRepairView = true;
  } else if (item.plyUrl) {
    $("generateBtn").classList.add("hidden");
    $("repairBtn").classList.remove("hidden");
    $("repairBtn").disabled = true;
    setActionText("repairBtn", "加载3D…");
  } else {
    $("repairBtn").classList.add("hidden");
    $("repairBtn").disabled = false;
    setActionText("repairBtn", "重构");
    $("generateBtn").classList.remove("hidden");
    $("generateBtn").disabled = false;
    setActionText("generateBtn", "生成");
  }
}

function clearActivePreview() {
  if (blockIfRepairing("重构时预览已锁定，暂不能取消当前预览")) return;

  state.generationToken += 1;
  state.repairToken += 1;
  state.isGenerating = false;
  state.comparing = false;
  state.inRepairView = false;

  disposeViewer();
  resetFrameEffects();
  setPreviewLocked(false);

  state.photoWidth = 0;
  state.photoHeight = 0;
  state.photoDataUrl = null;
  state.photoUrl = null;
  state.photoPath = null;
  state.photoName = null;
  state.plyPath = null;
  state.plyUrl = null;
  state.screenshotUrl = null;
  state.screenshotPath = null;
  state.repairUrl = null;
  state.repairPath = null;
  state.currentItemId = null;

  const frame = $("frame");
  frame.classList.remove("active");
  frame.style.backgroundImage = "none";
  const img = $("previewImg");
  img.src = "";
  img.classList.remove("visible", "splat-transition-out");
  $("canvasContainer").classList.remove("active");
  $("previewCloseBtn")?.classList.add("hidden");
  $("uploadPrompt").classList.remove("hidden");
  $("generateBtn").classList.add("hidden");
  $("repairBtn").classList.add("hidden");
  $("postGroup").classList.add("hidden");
  $("compareBtn").classList.remove("active");
  $("restoreBtn").textContent = "恢复3D";
  showModeBadge("");
  showViewHint(false);
  setDockActive("upload");
  renderGallery();
}

async function selectGalleryItem(id) {
  if (blockIfRepairing("重构时预览已锁定，请等重构完成后再切换图库")) return;
  const item = state.galleryItems.find((it) => it.id === id);
  if (!item) return;

  saveCurrentItem();
  state.currentItemId = id;
  state.generationToken += 1;
  state.repairToken += 1;
  resetFrameEffects();
  setDockActive("gallery");
  disposeViewer();

  applyPhotoToFrame(item);
  renderGallery();

  // If this photo already has a generated PLY but no repair result, restore its
  // 3D preview immediately so the user can continue rotating/reconstructing.
  if (item.plyUrl && !item.repairUrl) {
    try {
      await loadSplatPreview(item.plyUrl);
      if (state.currentItemId !== id) return;
      $("repairBtn").disabled = false;
      setActionText("repairBtn", "重构");
      showViewHint(true);
    } catch (err) {
      $("repairBtn").disabled = false;
      setActionText("repairBtn", "重构");
      showError("图库 3D 预览加载失败: " + (err.message || String(err)));
    }
  }
}

async function ensureViewerLoaded() {
  if (state.viewer) return;
  if (!state.plyUrl) throw new Error("这张照片还没有生成 3D，请先点击生成");
  await loadSplatPreview(state.plyUrl);
}

function fadeFromPhotoToSplat() {
  const img = $("previewImg");
  const container = $("canvasContainer");
  if (!img || !container.classList.contains("active")) return;

  // Wait two frames so the viewer has a real rendered frame. This prevents the
  // brief black flash that happens when the image is hidden immediately after
  // addSplatScene resolves but before the canvas is painted.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!container.classList.contains("active")) return;
      img.classList.add("splat-transition-out");

      const cleanup = () => {
        img.classList.remove("visible", "splat-transition-out");
        img.removeEventListener("transitionend", cleanup);
        // The original photo is only a temporary transition layer. Clear it
        // after the 3DGS canvas is visible so it won't appear underneath sparse splats.
        const frame = $("frame");
        if (frame && container.classList.contains("active")) {
          frame.style.backgroundImage = "none";
        }
      };
      img.addEventListener("transitionend", cleanup);
      setTimeout(cleanup, 700);
    });
  });
}

// ---------------------------------------------------------------------------
// Photo upload
// ---------------------------------------------------------------------------
async function onPhotoSelected(file) {
  if (!file) return;
  if (blockIfRepairing("重构时预览已锁定，请等重构完成后再上传")) return;

  saveCurrentItem();
  const uploadToken = ++state.generationToken;
  state.repairToken += 1;
  resetFrameEffects();
  setDockActive("upload");

  disposeViewer();
  $("canvasContainer").classList.remove("active");

  try {
    const dataUrl = await fileToDataUrl(file);
    const size = await imageSizeFromSrc(dataUrl);
    if (state.generationToken !== uploadToken) return;

    // Persist first and let the backend dedupe by SHA-256. The gallery only
    // stores original images; 3DGS / repair results remain workflow state.
    const persisted = await api('/api/gallery/import', {
      method: 'POST',
      body: JSON.stringify({
        imageData: dataUrl,
        imageName: file.name,
        photoWidth: size.width,
        photoHeight: size.height,
      }),
    });
    if (state.generationToken !== uploadToken) return;

    const old = state.galleryItems.find((it) => it.id === persisted.item.id) || {};
    const item = mergeBackendPhotoItem(old, persisted.item);
    item.photoDataUrl = dataUrl;
    state.galleryItems = [item, ...state.galleryItems.filter((it) => it.id !== item.id)];
    state.currentItemId = item.id;

    applyPhotoToFrame(item);
    setDockActive("gallery");
    $("generateBtn").classList.remove("hidden");
    $("generateBtn").disabled = false;
    setActionText("generateBtn", "生成");
    $("postGroup").classList.add("hidden");
    renderGallery();
  } catch (err) {
    if (err.message !== "__STALE_ASYNC_RESULT__") {
      showError("上传失败: " + (err.message || String(err)));
    }
  }
}

// ---------------------------------------------------------------------------
// Generate: SHARP predict (photo → PLY) → load 3D preview
// ---------------------------------------------------------------------------
async function generate() {
  if (blockIfRepairing("重构时不能开始新的生成任务")) return;
  const token = ++state.generationToken;
  if (!state.photoDataUrl && !state.photoUrl) {
    showError("请先上传一张照片");
    return;
  }
  state.isGenerating = true;

  $("generateBtn").disabled = true;
  setActionText("generateBtn", "生成中…");
  setFrameEffect("generate", true);

  try {
    // ── Stage 1: SHARP — photo → 3DGS .ply ──
    const sharpData = await api("/api/sharp/generate", {
      method: "POST",
      body: JSON.stringify({
        item_id: state.currentItemId,
        imageData: null,
        imageName: state.photoName,
      }),
    });
    assertFresh("generationToken", token);

    // Poll SHARP status until done.
    const plyPath = await pollSharpDone(sharpData.job_id, {
      timeoutMs: 15 * 60 * 1000,
      isActive: () => state.generationToken === token,
    });
    assertFresh("generationToken", token);
    state.plyPath = plyPath;

    // Build PLY URL (use vertex-only endpoint for GaussianSplats3D compat).
    const plyUrl = `/api/ply-vertex-only?path=${encodeURIComponent(plyPath)}`;
    state.plyUrl = plyUrl;
    saveCurrentItem();
    // Gallery persistence intentionally stores images only; keep PLY state in memory.
    renderGallery();

    // ── Stage 2: Load PLY into 3D viewer ──
    try {
      await loadSplatPreview(plyUrl);
      assertFresh("generationToken", token);
    } catch (loadErr) {
      console.error("[generate] 3D preview load failed:", loadErr);
      throw new Error("3D 预览加载失败: " + (loadErr.message || String(loadErr)));
    }

    // Transition to 3D preview mode.
    setFrameEffect("generate", false);
    $("generateBtn").classList.add("hidden");
    $("repairBtn").classList.remove("hidden");
    $("repairBtn").disabled = false;
    setActionText("repairBtn", "重构");
    showViewHint(true);
    saveCurrentItem();
    // Gallery persistence intentionally stores images only; keep 3D state in memory.
    renderGallery();
    state.isGenerating = false;
  } catch (err) {
    state.isGenerating = false;
    if (err.message === "__STALE_ASYNC_RESULT__") return;
    setFrameEffect("generate", false);
    setActionText("generateBtn", "生成");
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
    // Disable the built-in "Processing splats..." loading indicator.
    showLoadingUI: false,
  });

  state.viewer = viewer;
  tunePreviewControls(viewer);
  if (viewer.loadingSpinner) {
    viewer.loadingSpinner.hide();
    viewer.loadingSpinner.removeAllTasks?.();
  }
  if (viewer.loadingProgressBar) viewer.loadingProgressBar.hide();

  // Keep the original photo visible while GaussianSplats3D parses and renders.
  // Otherwise the canvas can show a black/empty frame for a moment near the end
  // of generation.  The canvas is activated underneath the photo, then we fade
  // the photo out only after the first splat frames have been drawn.
  container.classList.add("active");
  const previewImg = $("previewImg");
  if (state.photoDataUrl || state.photoUrl) previewImg.src = state.photoDataUrl || state.photoUrl;
  previewImg.classList.add("visible");
  previewImg.classList.remove("splat-transition-out");

  // Use the original photo as a temporary transition background only. It is
  // cleared after fadeFromPhotoToSplat(), otherwise sparse 3DGS holes would reveal
  // a second original photo underneath the preview.
  const frame = $("frame");
  if (state.photoDataUrl || state.photoUrl) {
    frame.style.backgroundImage = `url("${state.photoDataUrl || state.photoUrl}")`;
  }

  // Load the PLY file.
  // NOTE: Must pass format explicitly because the URL (/api/ply-vertex-only?path=...)
  // doesn't end with .ply, so GaussianSplats3D can't auto-detect the format.
  console.log("[loadSplatPreview] Loading splat scene...");
  try {
    await viewer.addSplatScene(plyUrl, { format: SceneFormat.Ply, showLoadingUI: false });
  } catch (loadErr) {
    // Loading failed — deactivate canvas so user sees the photo again.
    container.classList.remove("active");
    $("previewImg").classList.remove("splat-transition-out");
    $("previewImg").classList.add("visible");
    throw loadErr;
  }
  if (viewer.loadingSpinner) {
    viewer.loadingSpinner.hide();
    viewer.loadingSpinner.removeAllTasks?.();
  }
  if (viewer.loadingProgressBar) viewer.loadingProgressBar.hide();
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

    tunePreviewControls(viewer);

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

  // Now that the splat viewer is loaded and at least one frame will be painted,
  // fade the original photo out naturally instead of cutting to black.
  fadeFromPhotoToSplat();
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
  viewer.__fluxSharpRawRenderTarget = splatRT;
  viewer.__fluxSharpOriginalRender = viewer.render.bind(viewer);

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

  // Provide a RAW 3DGS screenshot path for ComfyUI. This bypasses the
  // feathered display pass and captures the original splat render with the
  // natural black holes expected by the downstream LoRA.
  viewer.__captureRawScreenshot = async function () {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const rawRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const pixels = new Uint8Array(size.x * size.y * 4);

    try {
      renderer.setRenderTarget(rawRT);
      renderer.autoClear = true;
      originalRender();
      renderer.readRenderTargetPixels(rawRT, 0, 0, size.x, size.y, pixels);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }

    const out = document.createElement('canvas');
    out.width = size.x;
    out.height = size.y;
    const ctx = out.getContext('2d');
    const imageData = ctx.createImageData(size.x, size.y);
    const rowBytes = size.x * 4;
    for (let y = 0; y < size.y; y++) {
      const srcStart = (size.y - 1 - y) * rowBytes;
      const dstStart = y * rowBytes;
      imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart);
    }
    ctx.putImageData(imageData, 0, 0);
    rawRT.dispose();
    return out.toDataURL('image/png');
  };
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
// Screenshot: capture RAW current 3DGS view as data URL.
// IMPORTANT: this intentionally captures the un-feathered GaussianSplats3D
// render with black holes/sparse areas. The preview UI may show a feathered
// fill for users, but ComfyUI + LoRA reconstruction should receive the raw 3DGS
// training-domain input, otherwise repair quality can degrade.
// ---------------------------------------------------------------------------
function captureRawSplatScreenshot() {
  const viewer = state.viewer;
  if (!viewer || !viewer.renderer) {
    throw new Error("3D 预览未就绪");
  }

  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      try {
        const renderer = viewer.renderer;
        const rawRT = viewer.__fluxSharpRawRenderTarget;

        if (rawRT) {
          const width = rawRT.width;
          const height = rawRT.height;

          // Make sure rawRT contains the newest camera frame. Calling the saved
          // original renderer while a render target is bound avoids the UI
          // feathering post-process entirely.
          const previousTarget = renderer.getRenderTarget();
          const savedAutoClear = renderer.autoClear;
          renderer.setRenderTarget(rawRT);
          renderer.autoClear = true;
          if (viewer.__fluxSharpOriginalRender) {
            viewer.__fluxSharpOriginalRender();
          }

          const pixels = new Uint8Array(width * height * 4);
          renderer.readRenderTargetPixels(rawRT, 0, 0, width, height, pixels);
          renderer.setRenderTarget(previousTarget);
          renderer.autoClear = savedAutoClear;

          const offscreenCanvas = document.createElement("canvas");
          offscreenCanvas.width = width;
          offscreenCanvas.height = height;
          const ctx = offscreenCanvas.getContext("2d");
          const imageData = ctx.createImageData(width, height);

          // WebGL readback is bottom-left origin; Canvas is top-left origin.
          const rowBytes = width * 4;
          for (let y = 0; y < height; y++) {
            const srcStart = (height - 1 - y) * rowBytes;
            const dstStart = y * rowBytes;
            imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart);
          }
          ctx.putImageData(imageData, 0, 0);
          resolve(offscreenCanvas.toDataURL("image/png"));
          return;
        }

        // Fallback for unexpected viewer internals: canvas capture. This is less
        // ideal because it may include UI feathering, so normal code paths should
        // always use the raw render target above.
        const canvas = renderer.domElement;
        const offscreenCanvas = document.createElement("canvas");
        offscreenCanvas.width = canvas.width;
        offscreenCanvas.height = canvas.height;
        offscreenCanvas.getContext("2d").drawImage(canvas, 0, 0);
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
  if (state.isRepairing) return;
  const token = ++state.repairToken;
  state.isRepairing = true;
  setPreviewLocked(true);

  try {
    if (!state.viewer) {
      await ensureViewerLoaded();
      assertFresh("repairToken", token);
    }

    $("repairBtn").disabled = true;
    $("generateBtn").disabled = true;
    $("compareBtn").disabled = true;
    $("restoreBtn").disabled = true;
    setActionText("repairBtn", "重构中…");
    setFrameEffect("reconstruct", true);

    // Capture RAW 3DGS for ComfyUI. Do not reuse the user-facing feathered
    // preview or a previous screenshot; LoRA repair expects raw 3DGS holes.
    const screenshotDataUrl = await captureRawSplatScreenshot();
    assertFresh("repairToken", token);

    const camMove = computeCameraMove();
    console.log("[repair] Camera move:", camMove);
    const prompt = buildRepairPrompt(camMove);

    const repairData = await api("/api/repair-screenshot", {
      method: "POST",
      body: JSON.stringify({
        item_id: state.currentItemId,
        photo: null,
        screenshot: screenshotDataUrl,
        prompt: prompt,
        steps: 4,
        megapixels: 1,
        ply_path: state.plyPath,
      }),
    });
    assertFresh("repairToken", token);

    state.screenshotUrl = repairData.screenshot_url;
    state.screenshotPath = repairData.screenshot_path || null;
    state.repairUrl = repairData.repair_url;
    state.repairPath = repairData.repair_path || null;
    saveCurrentItem();
    renderGallery();

    $("canvasContainer").classList.remove("active");
    const img = $("previewImg");
    img.src = `${state.repairUrl}&t=${Date.now()}`;
    img.classList.add("visible");
    state.inRepairView = true;

    $("restoreBtn").textContent = "恢复3D";
    $("repairBtn").classList.remove("hidden");
    setActionText("repairBtn", "重构");
    showViewHint(false);
    $("postGroup").classList.remove("hidden");
    state.comparing = false;
    showModeBadge("重构结果");
    $("compareBtn").classList.remove("active");
    saveCurrentItem();
    renderGallery();
  } catch (err) {
    if (err.message !== "__STALE_ASYNC_RESULT__") {
      showError(err.message || String(err));
    }
  } finally {
    if (state.repairToken === token) {
      state.isRepairing = false;
      setPreviewLocked(false);
      setFrameEffect("reconstruct", false);
      $("repairBtn").disabled = false;
      $("generateBtn").disabled = false;
      $("compareBtn").disabled = false;
      $("restoreBtn").disabled = false;
      setActionText("repairBtn", "重构");
    }
  }
}

// ---------------------------------------------------------------------------
// Compare: toggle between the uploaded original photo and the reconstruction result.
// The project reconstructs the photo angle, so comparison must be 原图 ↔ 重构结果,
// not 3D screenshot ↔ 重构结果.
// ---------------------------------------------------------------------------
async function toggleCompare() {
  if (!state.repairUrl || (!state.photoDataUrl && !state.photoUrl)) return;

  state.comparing = !state.comparing;
  const img = $("previewImg");
  $("canvasContainer").classList.remove("active");
  img.classList.add("visible");

  if (state.comparing) {
    img.src = await ensurePhotoDataUrl();
    state.inRepairView = true;
    showModeBadge("原图");
    $("compareBtn").classList.add("active");
  } else {
    img.src = `${state.repairUrl}&t=${Date.now()}`;
    showModeBadge("重构结果");
    $("compareBtn").classList.remove("active");
  }
}

// ---------------------------------------------------------------------------
// Restore 3D preview: show the canvas again with the same camera state as
// when the user clicked "修复". The viewer is still in memory so the render
// loop resumes automatically.
// ---------------------------------------------------------------------------
async function restorePreview() {
  if (!state.viewer) {
    try {
      await ensureViewerLoaded();
    } catch (err) {
      showError(err.message || String(err));
      return;
    }
  }

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
  showModeBadge("重构结果");
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
function pollSharpDone(jobId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const isActive = options.isActive ?? (() => true);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (!isActive()) {
        reject(new Error("__STALE_ASYNC_RESULT__"));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("SHARP 生成超时，请检查后端日志后重试"));
        return;
      }

      try {
        const status = await api(`/api/sharp/status?job_id=${encodeURIComponent(jobId)}`);
        if (!isActive()) {
          reject(new Error("__STALE_ASYNC_RESULT__"));
          return;
        }
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
  const handlePhotoInput = async (e) => {
    const file = e.target.files[0];
    if (file) await onPhotoSelected(file);
    e.target.value = "";
  };
  $("photoInput").addEventListener("change", handlePhotoInput);
  $("dockPhotoInput").addEventListener("change", handlePhotoInput);

  $("galleryBtn").addEventListener("click", () => {
    if (blockIfRepairing("重构时不能打开图库")) return;
    if (!state.galleryItems.length) {
      setDockActive("gallery");
      showError("图库里还没有图片，请先上传");
      renderGallery();
      return;
    }
    toggleGalleryPanel();
  });

  $("galleryCloseBtn")?.addEventListener("click", () => {
    $("galleryPanel")?.classList.add("hidden");
  });

  $("previewCloseBtn")?.addEventListener("click", () => {
    clearActivePreview();
  });

  $("generateBtn").addEventListener("click", () => {
    generate().catch((err) => showError(err.message));
  });

  $("repairBtn").addEventListener("click", () => {
    repair().catch((err) => showError(err.message));
  });

  $("compareBtn").addEventListener("click", () => {
    if (blockIfRepairing("重构时预览已锁定，暂不能对比")) return;
    toggleCompare().catch((err) => showError(err.message || String(err)));
  });

  $("restoreBtn").addEventListener("click", () => {
    if (blockIfRepairing("重构时预览已锁定，暂不能切换视图")) return;
    if (state.inRepairView) {
      restorePreview().catch((err) => showError(err.message || String(err)));
    } else {
      showRepairResult();
    }
  });

  $("exportBtn").addEventListener("click", () => {
    exportResult().catch((err) => showError(err.message));
  });

  // Window resize: update frame dimensions.
  window.addEventListener("resize", updateFrameSize);

  // Restore persistent gallery from backend so uploads survive refresh/restart.
  try {
    await loadPersistentGallery();
  } catch (err) {
    console.warn("[gallery] load persistent gallery failed", err);
  }

  // Initial status check + polling.
  await refreshStatus();
  if (state.galleryItems.length) {
    await selectGalleryItem(state.galleryItems[0].id);
  }
  setInterval(refreshStatus, 15000);
}

init().catch((err) => showError(err.message || String(err)));
