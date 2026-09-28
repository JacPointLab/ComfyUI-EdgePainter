// ComfyUI-EdgePainter (frontend)
// Only for "EdgePainter" nodes:
//  1. When the MaskEditor is opened FROM an Edge Painter node, it switches to a stroke-friendly profile
//     (white mask at full opacity, thin hard brush). Your normal MaskEditor settings are saved and
//     restored as soon as the editor closes, so the regular Load Image / MaskEditor stay untouched.
//     Brush changes you make inside Edge Painter are remembered separately for next time.
//  2. The node preview shows your strokes in white (instead of dark transparency) and, when the optional
//     `mask` input comes from a painted Load Image, dims everything outside the area you can paint in.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "EdgePainter";
const PENCIL = "EdgePencil";
const BRUSH_KEY = { [NODE]: "edgepainter.brush", [PENCIL]: "edgepencil.brush" };
const NATIVE_BRUSH_KEY = "maskeditor_brush_settings";
const BLACK_SIZE_KEY = "edgepencil.black_size";
const DEFAULT_BRUSH = { size: 3, opacity: 1, hardness: 1, stepSize: 2 };

// ---------------------------------------------------------------- store access (Pinia)
function pinia() {
  const el = document.querySelector("#vue-app") || [...document.querySelectorAll("body *")].find((e) => e.__vue_app__);
  return el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
}
const store = (id) => pinia()?._s?.get(id) ?? null;

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}

// ---------------------------------------------------------------- MaskEditor profile swap
// The MaskEditor loads its brush from localStorage when it opens and saves it back (sometimes after closing),
// so the user's own settings are restored several times after leaving, and the Edge Painter brush is tracked
// during the session instead of being read at close time.
const NATIVE_DEFAULT = { size: 10, opacity: 0.7, hardness: 1, stepSize: 5 };
let session = null;        // { blend, opacity, color, rawBrush, epBrush, timers[] }

const pickBrush = (b) => ({ size: b.size, opacity: b.opacity, hardness: b.hardness, stepSize: b.stepSize });

function applyBrush(s, b) {
  s.setBrushSize?.(b.size);
  s.setBrushOpacity?.(b.opacity);
  s.setBrushHardness?.(b.hardness);
  s.setBrushStepSize?.(b.stepSize);
}

// The native brush lives in sessionStorage ("<key>:<clientId>", read first) and in localStorage.
function snapshotNativeBrush() {
  const snap = { local: null, session: {}, effective: null };
  try {
    snap.local = localStorage.getItem(NATIVE_BRUSH_KEY);
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(NATIVE_BRUSH_KEY + ":")) snap.session[k] = sessionStorage.getItem(k);
    }
    snap.effective = Object.values(snap.session)[0] ?? snap.local;
  } catch { /* storage blocked */ }
  return snap;
}

function restoreNativeBrush(snap) {
  try {
    if (snap.local === null) localStorage.removeItem(NATIVE_BRUSH_KEY);
    else localStorage.setItem(NATIVE_BRUSH_KEY, snap.local);
    for (let i = sessionStorage.length - 1; i >= 0; i--) {    // keys written during the session
      const k = sessionStorage.key(i);
      if (k?.startsWith(NATIVE_BRUSH_KEY + ":") && !(k in snap.session)) sessionStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(snap.session)) sessionStorage.setItem(k, v);
  } catch { /* storage blocked */ }
}

function enterEdgePainter(kind) {
  const s = store("maskEditor");
  if (!s || session) return;
  session = {
    kind,
    blend: s.maskBlendMode, opacity: s.maskOpacity, color: { ...s.maskColor },
    layer: s.activeLayer, tool: s.currentTool, rgb: s.rgbColor,
    rawBrush: snapshotNativeBrush(),
    epBrush: { ...DEFAULT_BRUSH, ...(readJSON(BRUSH_KEY[kind]) || {}) },
    timers: [],
  };
  let first = true;
  const apply = () => {
    if (!session) return;
    s.maskBlendMode = "white";
    s.maskOpacity = 1;
    s.maskColor = { r: 255, g: 255, b: 255 };
    applyBrush(s, session.epBrush);
    if (kind === PENCIL && first) {        // pencil: paint layer, white; X toggles black/white
      s.activeLayer = "rgb";
      s.currentTool = "rgbPaint";
      s.rgbColor = "#FFFFFF";
    }
  };
  if (kind === PENCIL) {
    // white and black keep their own brush size (erasing usually wants a thicker brush)
    session.sizes = { white: session.epBrush.size, black: readJSON(BLACK_SIZE_KEY) ?? 12 };
    session.onKey = (e) => {
      if (e.key !== "x" && e.key !== "X") return;
      if (e.target?.closest?.("input, textarea, [contenteditable]")) return;
      const white = String(s.rgbColor).toUpperCase() !== "#000000";
      session.sizes[white ? "white" : "black"] = s.brushSettings.size;
      s.rgbColor = white ? "#000000" : "#FFFFFF";
      s.setBrushSize?.(session.sizes[white ? "black" : "white"]);
      if (s.currentTool !== "rgbPaint") { s.activeLayer = "rgb"; s.currentTool = "rgbPaint"; }
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener("keydown", session.onKey, true);
    session.timers.push(setTimeout(() => { first = false; }, 1100));
  }
  apply();
  // the editor may load the stored brush right after opening: re-apply, then start tracking changes
  session.timers.push(setTimeout(apply, 150), setTimeout(apply, 500), setTimeout(apply, 1000));
  session.timers.push(setTimeout(() => {
    if (session) session.timers.push(setInterval(() => {
      if (!session) return;
      session.epBrush = pickBrush(s.brushSettings);
      if (session.sizes) {                  // pencil: size of the colour in use
        const isBlack = String(s.rgbColor).toUpperCase() === "#000000";
        session.sizes[isBlack ? "black" : "white"] = s.brushSettings.size;
      }
    }, 250));
  }, 1200));
}

function leaveEdgePainter() {
  const s = store("maskEditor");
  if (!s || !session) return;
  const { kind, blend, opacity, color, layer, tool, rgb, rawBrush, epBrush, timers, onKey, sizes } = session;
  if (sizes) {                                   // pencil: remember the white and black sizes separately
    epBrush.size = sizes.white;
    writeJSON(BLACK_SIZE_KEY, sizes.black);
  }
  session = null;
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  if (onKey) window.removeEventListener("keydown", onKey, true);
  writeJSON(BRUSH_KEY[kind], epBrush);
  if (kind === PENCIL) {
    s.activeLayer = layer ?? "mask";
    s.currentTool = tool ?? "pen";
    if (rgb) s.rgbColor = rgb;
  }
  s.maskBlendMode = blend;
  s.maskOpacity = opacity;
  s.maskColor = color;
  let native = NATIVE_DEFAULT;
  try { native = { ...NATIVE_DEFAULT, ...(JSON.parse(rawBrush.effective || "null") || {}) }; } catch { /* keep default */ }
  const restore = () => {
    if (session) return;                                   // a new Edge Painter session started meanwhile
    applyBrush(s, native);
    restoreNativeBrush(rawBrush);
  };
  restore();
  [300, 1000, 2000].forEach((ms) => setTimeout(restore, ms));
}

const kindOf = (node) => [NODE, PENCIL].find((k) => node?.type === k || node?.comfyClass === k) ?? null;
let currentSource = null;

async function onSourceNode(node) {
  currentSource = node;
  const kind = kindOf(node);
  if (session && session.kind !== kind) leaveEdgePainter();
  if (!kind) { removeZoneOverlay(); leaveEdgePainter(); return; }
  // the "maskEditor" store is created when the editor mounts for the first time: wait for it
  for (let i = 0; i < 40 && !store("maskEditor"); i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (currentSource !== node) return;
  }
  enterEdgePainter(kind);
  if (kind === NODE) addZoneOverlay(node);
}

// ---------------------------------------------------------------- area shading inside the MaskEditor
// Display-only layer placed inside the editor's canvas container (so it follows zoom and pan), between the
// paint layer and the mask layer. It dims what lies outside the area given by the `mask` input. It is never
// saved: the MaskEditor only exports its own layers.
const OVERLAY_ID = "edgepainter-area-overlay";

function removeZoneOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
}

async function addZoneOverlay(node) {
  removeZoneOverlay();
  const zoneImg = zoneImageFor(node);
  if (!zoneImg) return;
  let box = null;
  for (let i = 0; i < 60 && currentSource === node; i++) {       // wait for the editor canvases
    box = document.getElementById("maskEditorCanvasContainer");
    const ref = box?.querySelector("canvas");
    if (ref?.width > 1 && zoneImg.complete && zoneImg.naturalWidth) break;
    box = null;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!box || currentSource !== node) return;
  const ref = box.querySelector("canvas");
  const w = ref.width, h = ref.height;
  const z = document.createElement("canvas");
  z.width = w; z.height = h;
  const zctx = z.getContext("2d");
  zctx.drawImage(zoneImg, 0, 0, w, h);
  let zd;
  try { zd = zctx.getImageData(0, 0, w, h).data; } catch { return; }
  if (!hasTransparency(zd)) return;                                 // upstream image has no painted area
  const out = zctx.createImageData(w, h), d = out.data;
  for (let i = 0; i < d.length; i += 4) if (zd[i + 3] > 128) d[i + 3] = 128;   // outside the area: 50% black
  zctx.putImageData(out, 0, 0);
  z.id = OVERLAY_ID;
  z.className = "absolute top-0 left-0 size-full";
  Object.assign(z.style, { zIndex: "20", pointerEvents: "none" });
  const mask = [...box.querySelectorAll("canvas")].find((c) => c.classList.contains("z-30"));
  box.insertBefore(z, mask ?? null);
}

function watchMaskEditor() {
  // "maskEditorData" is created when the editor opens for the first time (and may be recreated): poll for it
  // and compare its sourceNode; start from null so the very first opening is also detected.
  let last = null, subscribed = null;
  const check = () => {
    const data = store("maskEditorData");
    if (data && data !== subscribed) { subscribed = data; data.$subscribe?.(check, { flush: "sync" }); }
    const cur = data?.sourceNode ?? null;
    if (cur !== last) { last = cur; onSourceNode(cur); }
  };
  setInterval(check, 250);
}

// ---------------------------------------------------------------- node preview
// Strokes are shown in white (instead of dark transparency). If the optional `mask` input comes from a node
// with a painted image (e.g. a Load Image edited in the MaskEditor), everything outside that area is dimmed.
const previewCache = new Map();       // key -> composed image

function hasTransparency(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

function composedPreview(img, zoneImg) {
  if (!img?.complete || !img.naturalWidth) return img;
  const zoneReady = zoneImg?.complete && zoneImg.naturalWidth;
  const key = img.src + "|" + (zoneReady ? zoneImg.src : "");
  const hit = previewCache.get(key);
  if (hit) return hit.complete && hit.naturalWidth ? hit : img;
  previewCache.set(key, img);
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    let changed = false;
    if (hasTransparency(ctx.getImageData(0, 0, w, h).data)) {        // strokes -> white
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      changed = true;
    }
    if (zoneReady) {                                                  // dim outside the allowed area
      const z = document.createElement("canvas");
      z.width = w; z.height = h;
      const zctx = z.getContext("2d");
      zctx.drawImage(zoneImg, 0, 0, w, h);
      const zd = zctx.getImageData(0, 0, w, h).data;
      if (hasTransparency(zd)) {
        const out = ctx.getImageData(0, 0, w, h), d = out.data;
        for (let i = 0; i < d.length; i += 4) {
          if (zd[i + 3] > 128) { d[i] *= 0.5; d[i + 1] *= 0.5; d[i + 2] *= 0.5; }   // opaque = outside the area
        }
        ctx.putImageData(out, 0, 0);
        changed = true;
      }
    }
    if (!changed) return img;
    const res = new Image();
    res.onload = () => app.graph?.setDirtyCanvas(true, false);
    res.src = c.toDataURL("image/png");
    previewCache.set(key, res);
    if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value);
  } catch { /* cross-origin image: leave as is */ }
  return img;
}

function zoneImageFor(node) {
  const i = node.inputs?.findIndex((x) => x.name === "mask");
  if (i == null || i < 0 || node.inputs[i].link == null) return null;
  const up = node.getInputNode?.(i);
  if (!up) return null;
  if (up.imgs?.[0]) return up.imgs[0];    // painted Load Image / Edge Painter upstream: its alpha is the area
  // node not drawn yet (e.g. off-screen while the editor is open): load its image file directly
  const value = up.widgets?.find((w) => w.name === "image")?.value;
  return value ? imageFromWidgetValue(value) : null;
}

const fileImages = new Map();
function imageFromWidgetValue(value) {
  const clean = String(value).replace(/\s*\[(input|output|temp)\]$/, "");
  const type = /\[output\]$/.test(value) ? "output" : /\[temp\]$/.test(value) ? "temp" : "input";
  const cut = clean.lastIndexOf("/");
  const filename = cut < 0 ? clean : clean.slice(cut + 1), subfolder = cut < 0 ? "" : clean.slice(0, cut);
  const key = `${type}|${subfolder}|${filename}`;
  let img = fileImages.get(key);
  if (!img) {
    img = new Image();
    img.onload = () => app.graph?.setDirtyCanvas(true, false);
    img.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`);
    fileImages.set(key, img);
    if (fileImages.size > 30) fileImages.delete(fileImages.keys().next().value);
  }
  return img;
}

function wrapPreview(node) {
  const w = node.widgets?.find((x) => x.name === "$$canvas-image-preview");
  if (!w || w._edgePainter) return;
  const original = Object.getPrototypeOf(w)?.drawWidget;
  if (typeof original !== "function") return;     // different frontend version: do nothing
  w.drawWidget = function (ctx, opts = {}) {
    const n = this.node, imgs = n?.imgs;
    try {
      const zone = zoneImageFor(n);
      if (imgs?.length) n.imgs = imgs.map((im) => composedPreview(im, zone));
      return original.call(this, ctx, opts);
    } catch {
      return original.call(this, ctx, opts);
    } finally {
      if (n) n.imgs = imgs;
    }
  };
  w._edgePainter = true;
}

// ---------------------------------------------------------------- Edge Pencil node
// The server saves the incoming guide into input/edge_pencil/ and tells the node which file to paint on.
function hideWidget(w) {
  if (!w || w._epHidden) return;
  w._epHidden = true;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

function setupPencil(nodeType) {
  const created = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = created?.apply(this, arguments);
    hideWidget(this.widgets?.find((w) => w.name === "image"));
    hideWidget(this.widgets?.find((w) => w.name === "source"));
    this.addWidget("button", "restart from guide", null, () => {
      const src = this.widgets?.find((w) => w.name === "source");
      if (src) src.value = "";
      this.graph?.setDirtyCanvas(true, true);
    });
    return r;
  };
  // after loading a workflow, show the file the node points to (so the MaskEditor can open it without a run)
  const configure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = configure?.apply(this, arguments);
    setTimeout(() => {
      const value = this.widgets?.find((w) => w.name === "image")?.value;
      if (!value || this.imgs?.length) return;
      try {
        store("nodeOutput")?.setNodeOutputs?.(this, String(value).replace(/\s*\[input\]$/, ""), { folder: "input" });
        this.graph?.setDirtyCanvas(true, true);
      } catch { /* older frontend: the preview appears after the next run */ }
    }, 300);
    return r;
  };
  const executed = nodeType.prototype.onExecuted;
  nodeType.prototype.onExecuted = function (message) {
    const r = executed?.apply(this, arguments);
    const info = message?.edge_pencil?.[0];
    if (info) {
      for (const [name, value] of [["image", info.image], ["source", info.source]]) {
        const w = this.widgets?.find((x) => x.name === name);
        if (w) w.value = value;
      }
    }
    return r;
  };
  const drawBg = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function () {
    const r = drawBg?.apply(this, arguments);
    wrapPreview(this);
    return r;
  };
}

// ---------------------------------------------------------------- registration
app.registerExtension({
  name: "EdgePainter",
  async setup() {
    watchMaskEditor();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === PENCIL) return setupPencil(nodeType);
    if (nodeData.name !== NODE) return;
    const drawBg = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function () {
      const r = drawBg?.apply(this, arguments);
      wrapPreview(this);                  // runs before the widgets are drawn in the same frame
      return r;
    };
  },
});
