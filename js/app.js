import { store, loadIcons, searchIcons, getIcon, iconPreviewSVG } from './icons.js';
import {
  SHAPES, newComposition, newIconLayer, newShapeLayer, newTextLayer, renderSVG, layerMarkup, sanitizeSVGMarkup,
  exportSVG, svgToPNGBlob, normalizeComposition, shapeElement, clone, uid,
} from './compose.js';
import { PROVIDERS, EFFORTS, loadSettings, saveSettings, hasKey, modelLabel, aiVariants, aiPlan, runPool, callLLM } from './ai.js';
import { BADGE_POSITIONS, FAMILIES, normalizeGuide, describeGuide, applyStyleGuide } from './style.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const escHTML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PALETTE = ['#1f2937', '#ffffff', '#4f46e5', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

// ------------------------------------------------------------------ state
const state = {
  comp: newComposition(),
  selectedId: null,
  galleryId: null,      // ギャラリー上のどの作品を編集中か
  replaceMode: false,
  history: [], hIndex: -1,
  results: [], resultsShown: 0,
  ai: loadSettings(),
};

// ------------------------------------------------------------------ utils
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 5000 : 2200);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = (s) => (String(s || 'icon').trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'icon');
const exportSize = () => +$('#export-size').value || 512;

function storageGet(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function storageSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
}

let jszipPromise;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error('ZIPライブラリの読み込みに失敗しました')); };
    document.head.appendChild(s);
  });
  return jszipPromise;
}

function creditsText(comps) {
  const used = new Set();
  comps.forEach((c) => c.layers.forEach((l) => l.type === 'icon' && used.add(l.icon.split(':')[0])));
  let t = 'このZIPのアイコンは pretty-icon-gen で以下のオープンソースアイコンを組み合わせて作成しました。\n'
    + 'These icons were made with pretty-icon-gen by combining the following open-source icons.\n';
  const seen = new Set();
  for (const s of store.sets) {
    if (!used.has(s.id) || seen.has(s.licenseText)) continue;
    seen.add(s.licenseText);
    t += `\n==== ${s.name.replace(/ Filled$/, '')} ${s.version} (${s.url}) — ${s.license} License ====\n\n${s.licenseText}\n`;
  }
  return t;
}

async function zipCompositions(comps, filename) {
  if (!comps.length) return toast('対象がありません', true);
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const size = exportSize();
    const names = new Map();
    for (const c of comps) {
      let base = safeName(c.name);
      const k = names.get(base) || 0;
      names.set(base, k + 1);
      if (k) base += `_${k + 1}`;
      const svg = exportSVG(c, size);
      zip.file(`svg/${base}.svg`, svg);
      zip.file(`png/${base}.png`, await svgToPNGBlob(svg, size));
      zip.file(`project/${base}.json`, JSON.stringify(c, null, 2));
    }
    zip.file('CREDITS.txt', creditsText(comps));
    downloadBlob(await zip.generateAsync({ type: 'blob' }), filename);
  } catch (e) {
    toast(e.message, true);
  }
}

// ------------------------------------------------------------------ history
function record() {
  const snap = JSON.stringify(state.comp);
  if (state.history[state.hIndex] === snap) return;
  state.history = state.history.slice(0, state.hIndex + 1);
  state.history.push(snap);
  if (state.history.length > 100) state.history.shift();
  state.hIndex = state.history.length - 1;
  storageSet('pig.current', { comp: state.comp, galleryId: state.galleryId });
  updateUndoButtons();
}
function undo() {
  if (state.hIndex <= 0) return;
  state.hIndex--;
  state.comp = JSON.parse(state.history[state.hIndex]);
  afterLoad();
}
function redo() {
  if (state.hIndex >= state.history.length - 1) return;
  state.hIndex++;
  state.comp = JSON.parse(state.history[state.hIndex]);
  afterLoad();
}
function updateUndoButtons() {
  $('#btn-undo').disabled = state.hIndex <= 0;
  $('#btn-redo').disabled = state.hIndex >= state.history.length - 1;
}
function afterLoad() {
  if (!state.comp.layers.some((l) => l.id === state.selectedId)) state.selectedId = null;
  $('#comp-name').value = state.comp.name;
  renderBgProps();
  renderAll();
  storageSet('pig.current', { comp: state.comp, galleryId: state.galleryId });
  updateUndoButtons();
}
function loadComposition(comp, galleryId = null) {
  state.comp = clone(comp);
  state.galleryId = galleryId;
  state.selectedId = null;
  afterLoad();
  record();
}

// ------------------------------------------------------------------ stage
const stage = $('#stage');
const selected = () => state.comp.layers.find((l) => l.id === state.selectedId) || null;

// ---- スマホ用: 編集メニューの切り替え
const mobileMQ = matchMedia('(max-width: 760px)');
const coarseMQ = matchMedia('(pointer: coarse)');
const isMobile = () => mobileMQ.matches;
function setMobileSection(name) {
  $('#tab-editor').dataset.m = name;
  $$('#mobile-seg button').forEach((b) => b.classList.toggle('active', b.dataset.m === name));
}
$('#mobile-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (b) setMobileSection(b.dataset.m);
});

function stageMarkup() {
  const comp = state.comp;
  const defs = `<defs><pattern id="stage-checker" width="8" height="8" patternUnits="userSpaceOnUse">
    <rect width="8" height="8" fill="var(--checker)"/><rect width="4" height="4" fill="var(--stage-bg)"/><rect x="4" y="4" width="4" height="4" fill="var(--stage-bg)"/></pattern></defs>`;
  let out = defs + `<rect x="0" y="0" width="100" height="100" fill="url(#stage-checker)"/>`;
  out += `<line x1="50" y1="0" x2="50" y2="100" stroke="var(--border)" stroke-width="0.3" stroke-dasharray="1 1"/>`
    + `<line x1="0" y1="50" x2="100" y2="50" stroke="var(--border)" stroke-width="0.3" stroke-dasharray="1 1"/>`;
  out += renderSVG(comp, { width: 100, height: 100 });
  out += `<rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--border)" stroke-width="0.4"/>`;
  // ヒット領域（細い線でもクリックしやすいように）
  for (const l of comp.layers) {
    if (l.hidden) continue;
    const h = l.size / 2;
    out += `<rect class="layer-hit" data-hit="${l.id}" x="${-h}" y="${-h}" width="${l.size}" height="${l.size}" fill="transparent" transform="translate(${l.x} ${l.y}) rotate(${l.rotate || 0})"/>`;
  }
  const s = selected();
  if (s && !s.hidden) {
    const h = s.size / 2;
    const k = coarseMQ.matches ? 1.8 : 1; // タッチ操作ではハンドルを大きく
    out += `<g transform="translate(${s.x} ${s.y}) rotate(${s.rotate || 0})" pointer-events="none">
      <rect x="${-h}" y="${-h}" width="${s.size}" height="${s.size}" fill="none" stroke="var(--accent)" stroke-width="0.5" stroke-dasharray="1.5 1"/>
      <line x1="0" y1="${-h}" x2="0" y2="${-h - 6 * k}" stroke="var(--accent)" stroke-width="0.4"/></g>
      <g transform="translate(${s.x} ${s.y}) rotate(${s.rotate || 0})">
      <circle data-handle="rotate" cx="0" cy="${-h - 6 * k}" r="${2.2 * k}" fill="var(--panel)" stroke="var(--accent)" stroke-width="0.6" style="cursor:grab"/>
      <rect data-handle="scale" x="${h - 2 * k}" y="${h - 2 * k}" width="${4 * k}" height="${4 * k}" rx="0.8" fill="var(--accent)" style="cursor:nwse-resize"/></g>`;
  }
  return out;
}

function renderStage() {
  stage.innerHTML = stageMarkup();
  $('#mobile-seg [data-m="adjust"]').classList.toggle('has-sel', !!state.selectedId);
}
function renderAll() {
  renderStage();
  renderLayerList();
  renderLayerProps();
}

function svgPoint(evt) {
  const pt = stage.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(stage.getScreenCTM().inverse());
}

let drag = null;
const pointers = new Map(); // pointerId -> {x, y}（ステージ座標）

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

stage.addEventListener('pointerdown', (e) => {
  const p = svgPoint(e);
  pointers.set(e.pointerId, p);
  try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
  // 2本指: 選択中のレイヤーをピンチで拡大縮小・回転
  if (pointers.size === 2) {
    const l = selected();
    if (!l) { drag = null; return; }
    const { dist, angle } = pinchInfo();
    drag = { mode: 'pinch', l, dist0: dist, angle0: angle, size0: l.size, rot0: l.rotate || 0 };
    return;
  }
  if (pointers.size > 2) return;
  const handle = e.target.closest('[data-handle]');
  const hit = e.target.closest('[data-hit]');
  if (handle && selected()) {
    const l = selected();
    drag = { mode: handle.dataset.handle, l, p0: p, size0: l.size, dist0: Math.hypot(p.x - l.x, p.y - l.y) || 1 };
  } else if (hit) {
    state.selectedId = hit.dataset.hit;
    const l = selected();
    drag = { mode: 'move', l, p0: p, x0: l.x, y0: l.y };
    renderAll();
  } else {
    drag = null;
    if (state.selectedId) { state.selectedId = null; renderAll(); }
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = svgPoint(e);
  pointers.set(e.pointerId, p);
  if (!drag) return;
  const l = drag.l;
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) return;
    const { dist, angle } = pinchInfo();
    l.size = Math.max(2, Math.round(drag.size0 * (dist / drag.dist0) * 10) / 10);
    let r = drag.rot0 + ((angle - drag.angle0) * 180) / Math.PI;
    r = ((r + 540) % 360) - 180;
    // 45°の倍数付近には吸着
    const m = ((r % 45) + 45) % 45;
    l.rotate = m < 3 || m > 42 ? Math.round(r / 45) * 45 : Math.round(r);
  } else if (drag.mode === 'move') {
    let x = drag.x0 + (p.x - drag.p0.x), y = drag.y0 + (p.y - drag.p0.y);
    if (!e.altKey) {
      if (Math.abs(x - 50) < 1.5) x = 50;
      if (Math.abs(y - 50) < 1.5) y = 50;
    }
    l.x = Math.round(x * 10) / 10; l.y = Math.round(y * 10) / 10;
  } else if (drag.mode === 'scale') {
    const d = Math.hypot(p.x - l.x, p.y - l.y);
    l.size = Math.max(2, Math.round(drag.size0 * (d / drag.dist0) * 10) / 10);
  } else if (drag.mode === 'rotate') {
    let a = (Math.atan2(p.y - l.y, p.x - l.x) * 180) / Math.PI + 90;
    if (a > 180) a -= 360;
    a = e.shiftKey ? Math.round(a) : Math.round(a / 15) * 15;
    l.rotate = a;
  } else {
    return;
  }
  renderStage();
  refreshPropValues();
});
const endDrag = (e) => {
  pointers.delete(e.pointerId);
  if (!drag) return;
  if (pointers.size) {
    // ピンチ後に1本指が残っても、指を全部離すまでは移動に切り替えない
    if (drag.mode === 'pinch') drag = { mode: 'none', l: drag.l };
    return;
  }
  drag = null;
  renderLayerList();
  record();
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// 検索結果からのドラッグ&ドロップ
const stageWrap = $('#stage-wrap');
stageWrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
stageWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  const id = e.dataTransfer.getData('text/x-icon-id');
  if (!id || !getIcon(id)) return;
  const p = svgPoint(e);
  addIconSmart(id, { x: Math.round(p.x), y: Math.round(p.y) });
});

// ------------------------------------------------------------------ layer operations
function defaultIconColor() {
  const bg = state.comp.background;
  return bg.shape !== 'none' ? '#ffffff' : '#1f2937';
}

function addIconSmart(iconId, pos = null) {
  const comp = state.comp;
  const hasIcon = comp.layers.some((l) => l.type === 'icon');
  const bg = comp.background;
  let layer;
  if (!hasIcon) {
    layer = newIconLayer(iconId, { size: bg.shape !== 'none' ? 54 : 70, color: defaultIconColor() });
  } else {
    layer = newIconLayer(iconId, {
      x: 72, y: 72, size: 38, color: bg.shape !== 'none' ? '#ffffff' : '#4f46e5',
      halo: 4, haloColor: bg.shape !== 'none' ? bg.color : '#ffffff',
    });
  }
  if (pos) Object.assign(layer, pos);
  comp.layers.push(layer);
  state.selectedId = layer.id;
  renderAll();
  record();
}

function replaceSelectedIcon(iconId) {
  const l = selected();
  if (!l || l.type !== 'icon') return;
  l.icon = iconId;
  state.replaceMode = false;
  renderAll();
  record();
  toast('アイコンを差し替えました');
  if (isMobile()) setMobileSection('adjust');
}

function moveLayer(id, dir) {
  const arr = state.comp.layers;
  const i = arr.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderAll();
  record();
}
function deleteLayer(id) {
  state.comp.layers = state.comp.layers.filter((l) => l.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderAll();
  record();
}
function duplicateLayer(id) {
  const i = state.comp.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const c = { ...clone(state.comp.layers[i]), id: uid() };
  c.x = Math.min(100, c.x + 4); c.y = Math.min(100, c.y + 4);
  state.comp.layers.splice(i + 1, 0, c);
  state.selectedId = c.id;
  renderAll();
  record();
}

function layerLabel(l) {
  if (l.type === 'icon') return l.icon;
  if (l.type === 'shape') return `図形: ${SHAPES[l.shape] || l.shape}`;
  if (l.type === 'draw') return '描画（SVG）';
  return `テキスト: ${l.text}`;
}

function renderLayerList() {
  const ul = $('#layer-list');
  const layers = [...state.comp.layers].reverse();
  if (!layers.length) {
    ul.innerHTML = '<li class="hint">左の検索結果からアイコンをクリック（またはドラッグ）して追加</li>';
    return;
  }
  ul.innerHTML = layers.map((l) => {
    const thumbComp = { background: { shape: 'none' }, layers: [{ ...l, hidden: false, x: 50, y: 50, size: l.type === 'text' ? 60 : 80, rotate: 0, halo: 0 }] };
    return `<li class="layer-item ${l.id === state.selectedId ? 'selected' : ''} ${l.hidden ? 'hidden-layer' : ''}" data-id="${l.id}">
      <span class="layer-thumb">${renderSVG(thumbComp)}</span>
      <span class="layer-name" title="${escHTML(layerLabel(l))}">${escHTML(layerLabel(l))}</span>
      <button class="btn tiny" data-act="hide" title="表示/非表示">${l.hidden ? '◌' : '◉'}</button>
      <button class="btn tiny" data-act="up" title="前面へ">▲</button>
      <button class="btn tiny" data-act="down" title="背面へ">▼</button>
      <button class="btn tiny" data-act="dup" title="複製">⧉</button>
      <button class="btn tiny danger" data-act="del" title="削除">✕</button>
    </li>`;
  }).join('');
}
$('#layer-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'up') return moveLayer(id, +1);
  if (act === 'down') return moveLayer(id, -1);
  if (act === 'del') return deleteLayer(id);
  if (act === 'dup') return duplicateLayer(id);
  if (act === 'hide') {
    const l = state.comp.layers.find((x) => x.id === id);
    l.hidden = !l.hidden;
    renderAll();
    return record();
  }
  state.selectedId = id;
  renderAll();
  if (isMobile()) setMobileSection('adjust');
});

// ------------------------------------------------------------------ property forms
function fieldHTML(f, obj) {
  const v = obj[f.k];
  const id = `f-${f.scope}-${f.k}`;
  let ctl = '';
  switch (f.type) {
    case 'range':
      ctl = `<div class="ctl"><input type="range" id="${id}" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${v}">
        <input type="number" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${v}"></div>`;
      break;
    case 'color':
      ctl = `<div class="ctl"><input type="color" id="${id}" data-k="${f.k}" value="${v || '#000000'}">
        <div class="swatches">${PALETTE.map((c) => `<button type="button" class="swatch" style="background:${c}" data-k="${f.k}" data-color="${c}" title="${c}"></button>`).join('')}</div></div>`;
      break;
    case 'check':
      ctl = `<div class="ctl"><input type="checkbox" id="${id}" data-k="${f.k}" ${v ? 'checked' : ''}></div>`;
      break;
    case 'select':
      ctl = `<select id="${id}" data-k="${f.k}">${Object.entries(f.options).map(([val, lab]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${lab}</option>`).join('')}</select>`;
      break;
    case 'text':
      ctl = `<input type="text" id="${id}" data-k="${f.k}" value="${escHTML(v ?? '')}" maxlength="${f.max || 40}">`;
      break;
    case 'html':
      return `<div class="full">${f.html}</div>`;
    default:
  }
  return `<label for="${id}">${f.label}</label>${ctl}`;
}

function bindForm(container, getObj, fields, onChange) {
  const types = Object.fromEntries(fields.map((f) => [f.k, f.type]));
  const apply = (el, commit) => {
    const obj = getObj();
    if (!obj) return;
    const k = el.dataset.k;
    if (!k || !(k in types)) return;
    let val;
    if (el.dataset.color) val = el.dataset.color;
    else if (types[k] === 'check') val = el.checked;
    else if (types[k] === 'range') val = parseFloat(el.value);
    else val = el.value;
    if (types[k] === 'range' && !Number.isFinite(val)) return;
    obj[k] = val;
    // 同じキーの別コントロールを同期
    $$(`[data-k="${k}"]`, container).forEach((o) => {
      if (o === el || o.dataset.color) return;
      if (o.type === 'checkbox') o.checked = !!val; else o.value = val;
    });
    onChange(k, commit);
  };
  container.oninput = (e) => apply(e.target, false);
  container.onchange = (e) => apply(e.target, true);
  container.onclick = (e) => { const sw = e.target.closest('.swatch'); if (sw) apply(sw, true); };
}

const BG_FIELDS = [
  { k: 'shape', label: '形', type: 'select', options: { none: 'なし（透明）', ...SHAPES } },
  { k: 'color', label: '色', type: 'color' },
  { k: 'color2', label: 'グラデ終点', type: 'color' },
  { k: 'size', label: '大きさ', type: 'range', min: 20, max: 100, step: 1 },
  { k: 'outline', label: '縁取り', type: 'range', min: 0, max: 12, step: 0.5 },
  { k: 'outlineColor', label: '縁取りの色', type: 'color' },
].map((f) => ({ ...f, scope: 'bg' }));

function renderBgProps() {
  const el = $('#bg-props');
  const bg = state.comp.background;
  el.innerHTML = BG_FIELDS.map((f) => {
    if (f.k === 'color2') {
      return `<label>グラデーション</label><div class="ctl"><input type="checkbox" id="bg-grad" ${bg.color2 ? 'checked' : ''}>
        <input type="color" data-k="color2" value="${bg.color2 || '#ec4899'}" ${bg.color2 ? '' : 'disabled'}></div>`;
    }
    return fieldHTML(f, bg);
  }).join('');
  bindForm(el, () => state.comp.background, BG_FIELDS, (k, commit) => {
    renderStage();
    if (commit) record();
  });
  $('#bg-grad', el).onchange = (e) => {
    const c2 = $('[data-k="color2"]', el);
    c2.disabled = !e.target.checked;
    state.comp.background.color2 = e.target.checked ? c2.value : '';
    renderStage();
    record();
  };
}

function layerFields(l) {
  const common = [
    { k: 'x', label: 'X', type: 'range', min: 0, max: 100, step: 0.5 },
    { k: 'y', label: 'Y', type: 'range', min: 0, max: 100, step: 0.5 },
    { k: 'size', label: 'サイズ', type: 'range', min: 2, max: 140, step: 0.5 },
    { k: 'rotate', label: '回転', type: 'range', min: -180, max: 180, step: 1 },
    { k: 'opacity', label: '不透明度', type: 'range', min: 0, max: 1, step: 0.05 },
    { k: 'flipX', label: '左右反転', type: 'check' },
    { k: 'flipY', label: '上下反転', type: 'check' },
    { k: 'halo', label: 'くり抜き縁', type: 'range', min: 0, max: 12, step: 0.5 },
    { k: 'haloColor', label: '縁の色', type: 'color' },
  ];
  let specific = [];
  if (l.type === 'icon') {
    const icon = getIcon(l.icon);
    specific = [
      { k: '_info', type: 'html', html: `<div class="row space"><code>${escHTML(l.icon)}</code><button type="button" class="btn small" id="btn-replace">${state.replaceMode ? '検索結果をクリック…' : '差し替え'}</button></div>` },
      { k: 'color', label: '色', type: 'color' },
      ...(icon?.style === 'fill' ? [] : [{ k: 'strokeWidth', label: '線の太さ', type: 'range', min: 0.5, max: 4, step: 0.25 }]),
    ];
  } else if (l.type === 'draw') {
    specific = [
      { k: '_code', type: 'html', html: `<details class="draw-code"><summary>SVGコードを編集</summary>
        <textarea id="draw-markup" rows="6" spellcheck="false">${escHTML(l.markup)}</textarea>
        <div class="row"><button type="button" class="btn small" id="btn-draw-apply">反映</button>
        <span class="hint">0〜100の座標。path・circle・rect などが使えます</span></div></details>` },
    ];
    return [...specific, ...common.filter((f) => f.k !== 'halo' && f.k !== 'haloColor')].map((f) => ({ ...f, scope: 'layer' }));
  } else if (l.type === 'shape') {
    specific = [
      { k: 'shape', label: '形', type: 'select', options: SHAPES },
      { k: 'color', label: '色', type: 'color' },
      { k: 'outline', label: '輪郭のみ(太さ)', type: 'range', min: 0, max: 20, step: 0.5 },
    ];
  } else {
    specific = [
      { k: 'text', label: 'テキスト', type: 'text', max: 12 },
      { k: 'color', label: '色', type: 'color' },
      { k: 'weight', label: '太さ', type: 'select', options: { 400: '標準', 700: '太字', 900: '極太' } },
    ];
  }
  return [...specific, ...common].map((f) => ({ ...f, scope: 'layer' }));
}

function renderLayerProps() {
  const el = $('#layer-props');
  const l = selected();
  if (!l) {
    el.innerHTML = '<p class="hint full">キャンバス上のパーツをクリックして選択</p>';
    el.oninput = el.onchange = el.onclick = null;
    return;
  }
  const fields = layerFields(l);
  el.innerHTML = fields.map((f) => fieldHTML(f, l)).join('');
  bindForm(el, selected, fields, (k, commit) => {
    if (k === 'weight') selected().weight = +selected().weight;
    renderStage();
    if (commit) { renderLayerList(); record(); }
  });
  const da = $('#btn-draw-apply', el);
  if (da) {
    da.onclick = () => {
      const markup = sanitizeSVGMarkup($('#draw-markup', el).value);
      if (!markup) return toast('SVGを読み取れませんでした（使える要素: g, path, circle, ellipse, rect, line, polyline, polygon）', true);
      selected().markup = markup;
      renderStage();
      renderLayerList();
      record();
      toast('反映しました');
    };
  }
  const rb = $('#btn-replace', el);
  if (rb) {
    rb.onclick = () => {
      state.replaceMode = !state.replaceMode;
      rb.textContent = state.replaceMode ? '検索結果をクリック…' : '差し替え';
      if (state.replaceMode) {
        toast('検索結果から差し替えるアイコンを選んでください');
        if (isMobile()) setMobileSection('search');
        else $('#q').focus();
      }
    };
  }
}

function refreshPropValues() {
  const l = selected();
  if (!l) return;
  $$('#layer-props [data-k]').forEach((el) => {
    if (el === document.activeElement || el.dataset.color) return;
    const v = l[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else if (v != null) el.value = v;
  });
}

// ------------------------------------------------------------------ search
function selectedSets() {
  return $$('#set-filter input:checked').map((i) => i.value);
}

const RESULTS_PAGE = 240;
function runSearch() {
  const q = $('#q').value;
  const sets = selectedSets();
  state.results = searchIcons(q, { sets, limit: 2000 });
  state.resultsShown = 0;
  $('#results').innerHTML = '';
  showMoreResults();
  const total = sets.reduce((a, s) => a + store.icons.filter((i) => i.set === s).length, 0);
  $('#search-hint').textContent = q.trim()
    ? `「${q}」: ${state.results.length}件${state.results.length === 0 ? '（英語や別の言い方でも試してみてください）' : ''}`
    : `全${total.toLocaleString()}件 — 単語を入れると関連アイコンが出ます`;
}
function showMoreResults() {
  const slice = state.results.slice(state.resultsShown, state.resultsShown + RESULTS_PAGE);
  $('#results').insertAdjacentHTML('beforeend', slice.map((icon) =>
    `<button class="icon-btn" draggable="true" data-icon="${icon.id}" title="${icon.id}${icon.tags.length ? `\n${escHTML(icon.tags.slice(0, 8).join(', '))}` : ''}">${iconPreviewSVG(icon)}</button>`).join(''));
  state.resultsShown += slice.length;
  $('#more-results').hidden = state.resultsShown >= state.results.length;
}
let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
$('#more-results').addEventListener('click', showMoreResults);
$('#results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-icon]');
  if (!b) return;
  if (state.replaceMode && selected()?.type === 'icon') replaceSelectedIcon(b.dataset.icon);
  else addIconSmart(b.dataset.icon);
});
$('#results').addEventListener('dragstart', (e) => {
  const b = e.target.closest('[data-icon]');
  if (b) e.dataTransfer.setData('text/x-icon-id', b.dataset.icon);
});

// 図形・テキスト
$('#shape-buttons').innerHTML = Object.entries(SHAPES).map(([k, lab]) =>
  `<button class="icon-btn" data-shape="${k}" title="${lab}"><svg viewBox="-12 -12 24 24">${shapeElement(k, 20, 'fill="currentColor"')}</svg></button>`).join('');
$('#shape-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shape]');
  if (!b) return;
  const first = !state.comp.layers.length;
  const layer = newShapeLayer(b.dataset.shape, first ? { x: 50, y: 50, size: 90, color: '#4f46e5' } : {});
  if (first) state.comp.layers.unshift(layer);
  else {
    // バッジの土台として、最後のアイコンの下に入れる
    const idx = state.comp.layers.length - (state.comp.layers.at(-1)?.type === 'icon' && state.comp.layers.length > 1 ? 1 : 0);
    state.comp.layers.splice(idx, 0, layer);
  }
  state.selectedId = layer.id;
  renderAll();
  record();
});
$('#btn-add-text').addEventListener('click', () => {
  const t = $('#text-to-add').value.trim();
  if (!t) return $('#text-to-add').focus();
  const layer = newTextLayer(t, { size: t.length > 2 ? 28 : 40, color: defaultIconColor() });
  state.comp.layers.push(layer);
  state.selectedId = layer.id;
  $('#text-to-add').value = '';
  renderAll();
  record();
});

// 配置プリセット
$('#place-row').addEventListener('click', (e) => {
  const l = selected();
  const b = e.target.closest('button');
  if (!b) return;
  if (!l) return toast('先にレイヤーを選択してください');
  if (b.dataset.place) {
    const m = Math.max(l.size / 2 + 4, 10);
    const pos = { c: [50, 50], tl: [m, m], tr: [100 - m, m], bl: [m, 100 - m], br: [100 - m, 100 - m] }[b.dataset.place];
    [l.x, l.y] = pos.map((v) => Math.round(v * 10) / 10);
  }
  if (b.dataset.size) l.size = +b.dataset.size;
  renderAll();
  record();
});

// ------------------------------------------------------------------ toolbar & export
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#btn-new').onclick = () => {
  if (state.comp.layers.length && !confirm('今のキャンバスをクリアして新規作成しますか？（ギャラリーに保存していない内容は失われます）')) return;
  loadComposition(newComposition());
};
$('#comp-name').addEventListener('input', (e) => { state.comp.name = e.target.value; });
$('#comp-name').addEventListener('change', record);

$('#btn-dl-svg').onclick = () => {
  downloadBlob(new Blob([exportSVG(state.comp, exportSize())], { type: 'image/svg+xml' }), `${safeName(state.comp.name)}.svg`);
};
$('#btn-dl-png').onclick = async () => {
  try {
    const size = exportSize();
    downloadBlob(await svgToPNGBlob(exportSVG(state.comp, size), size), `${safeName(state.comp.name)}_${size}.png`);
  } catch (e) { toast(e.message, true); }
};
$('#btn-copy-svg').onclick = async () => {
  try {
    await navigator.clipboard.writeText(exportSVG(state.comp, exportSize()));
    toast('SVGコードをコピーしました');
  } catch { toast('コピーできませんでした', true); }
};
$('#btn-dl-json').onclick = () => {
  downloadBlob(new Blob([JSON.stringify(state.comp, null, 2)], { type: 'application/json' }), `${safeName(state.comp.name)}.json`);
};
$('#input-json').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { comp, warnings } = normalizeComposition(JSON.parse(await f.text()));
    loadComposition(comp);
    toast(warnings.length ? `読み込みました（${warnings.length}件のパーツをスキップ）` : '読み込みました');
  } catch (err) { toast(`読み込みに失敗しました: ${err.message}`, true); }
};
$('#btn-save-gallery').onclick = () => {
  state.galleryId = saveToGallery(state.comp, state.galleryId);
  record();
  toast('ギャラリーに保存しました');
};

// キーボード操作
document.addEventListener('keydown', (e) => {
  if (!$('#tab-editor').classList.contains('active')) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  const l = selected();
  if (!l) return;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); return duplicateLayer(l.id); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return deleteLayer(l.id); }
  if (e.key === 'Escape') { state.selectedId = null; return renderAll(); }
  const step = e.shiftKey ? 5 : 0.5;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    l.x += d[0]; l.y += d[1];
    renderStage();
    refreshPropValues();
    record();
  }
});

// ------------------------------------------------------------------ gallery
const GALLERY_KEY = 'pig.gallery';
let gallery = storageGet(GALLERY_KEY, []);

function persistGallery() {
  if (!storageSet(GALLERY_KEY, gallery)) toast('ブラウザの保存容量が不足しています。バックアップしてから不要な作品を削除してください', true);
  $('#gallery-count').textContent = gallery.length;
}
function saveToGallery(comp, id = null) {
  const now = Date.now();
  const existing = id && gallery.find((g) => g.id === id);
  if (existing) {
    existing.comp = clone(comp);
    existing.updated = now;
  } else {
    id = `g${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    gallery.unshift({ id, comp: clone(comp), updated: now });
  }
  persistGallery();
  renderGallery();
  return id;
}
function renderGallery() {
  const el = $('#gallery');
  if (!gallery.length) {
    el.innerHTML = '<p class="hint">まだ保存された作品はありません。エディタの「ギャラリーに保存」か、AI一括発注の結果から保存できます。</p>';
    return;
  }
  el.innerHTML = gallery.map((g) => `<div class="card" data-id="${g.id}">
    <div class="thumb">${renderSVG(g.comp)}</div>
    <div class="title" title="${escHTML(g.comp.name)}">${escHTML(g.comp.name)}</div>
    <div class="sub">${new Date(g.updated).toLocaleString()}</div>
    <div class="actions">
      <button class="btn primary" data-act="edit">編集</button>
      <button class="btn" data-act="svg">SVG</button>
      <button class="btn" data-act="png">PNG</button>
      <button class="btn danger" data-act="del">削除</button>
    </div></div>`).join('');
}
$('#gallery').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-id]');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !act) return;
  const g = gallery.find((x) => x.id === card.dataset.id);
  if (!g) return;
  if (act === 'edit') { loadComposition(g.comp, g.id); switchTab('editor'); }
  if (act === 'svg') downloadBlob(new Blob([exportSVG(g.comp, exportSize())], { type: 'image/svg+xml' }), `${safeName(g.comp.name)}.svg`);
  if (act === 'png') downloadBlob(await svgToPNGBlob(exportSVG(g.comp, exportSize()), exportSize()), `${safeName(g.comp.name)}.png`);
  if (act === 'del' && confirm(`「${g.comp.name}」を削除しますか？`)) {
    gallery = gallery.filter((x) => x !== g);
    if (state.galleryId === g.id) state.galleryId = null;
    persistGallery();
    renderGallery();
  }
});
$('#btn-gallery-zip').onclick = () => zipCompositions(gallery.map((g) => g.comp), 'icons.zip');
$('#btn-gallery-export').onclick = () => {
  downloadBlob(new Blob([JSON.stringify({ type: 'pretty-icon-gen-gallery', items: gallery }, null, 2)], { type: 'application/json' }), 'pretty-icon-gen-gallery.json');
};
$('#input-gallery').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const items = Array.isArray(data) ? data : data.items || [];
    let n = 0;
    for (const it of items) {
      const { comp } = normalizeComposition(it.comp || it);
      if (comp.layers.length) { saveToGallery(comp); n++; }
    }
    toast(`${n}件を復元しました`);
  } catch (err) { toast(`復元に失敗しました: ${err.message}`, true); }
};

// ------------------------------------------------------------------ tabs & dialogs
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));


$('#btn-license').onclick = () => {
  const counts = {};
  store.icons.forEach((i) => { counts[i.set] = (counts[i.set] || 0) + 1; });
  $('#license-list').innerHTML = store.sets.map((s) => `<div class="license-item">
    <strong>${escHTML(s.name)}</strong> v${escHTML(s.version)} — ${counts[s.id] || 0}個 — <strong>${escHTML(s.license)}</strong> License
    — <a href="${s.url}" target="_blank" rel="noopener">${s.url}</a></div>`).join('');
  $('#dlg-license').showModal();
};

const CUSTOM_MODEL = '__custom__';
const modelOptions = (provider, current, withCustom) => {
  const models = PROVIDERS[provider]?.models || [];
  let html = models.map((m) => `<option value="${m.id}" ${m.id === current ? 'selected' : ''}>${m.label}</option>`).join('');
  const known = models.some((m) => m.id === current);
  if (!known && current && !withCustom) html += `<option value="${escHTML(current)}" selected>${escHTML(current)}</option>`;
  if (withCustom) html += `<option value="${CUSTOM_MODEL}" ${known ? '' : 'selected'}>その他（モデルIDを入力）</option>`;
  return html;
};

function updateAIIndicators() {
  const on = hasKey(state.ai);
  $('#ai-status-dot').classList.toggle('on', on);
  $('#ai-assist-hint').textContent = on
    ? `${PROVIDERS[state.ai.provider]?.label || state.ai.provider} / ${modelLabel(state.ai)}`
    : 'AI設定でAPIキーを入れると使えます';
  $$('.model-quick').forEach((sel) => { sel.innerHTML = modelOptions(state.ai.provider, state.ai.model, false); });
}
// 画面上のモデル選択（エディタ・一括発注）からの切り替え
$$('.model-quick').forEach((sel) => sel.addEventListener('change', (e) => {
  state.ai = { ...state.ai, model: e.target.value };
  saveSettings(state.ai);
  updateAIIndicators();
  toast(`モデルを ${modelLabel(state.ai)} にしました`);
}));

function fillModelList(provider, current) {
  $('#ai-model-select').innerHTML = modelOptions(provider, current, true);
  $('#ai-model').value = current || '';
  $('#ai-model-custom').hidden = $('#ai-model-select').value !== CUSTOM_MODEL;
  $('#ai-key').placeholder = PROVIDERS[provider]?.keyHint || '';
  $('#ai-effort').disabled = !PROVIDERS[provider]?.supportsEffort;
}
$('#ai-provider').innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
$('#ai-effort').innerHTML = Object.entries(EFFORTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#ai-provider').onchange = (e) => fillModelList(e.target.value, PROVIDERS[e.target.value].models[0].id);
$('#ai-model-select').onchange = (e) => {
  const custom = e.target.value === CUSTOM_MODEL;
  $('#ai-model-custom').hidden = !custom;
  if (custom) $('#ai-model').focus();
};
function readAIForm() {
  const provider = $('#ai-provider').value;
  const sel = $('#ai-model-select').value;
  return {
    provider,
    model: (sel === CUSTOM_MODEL ? $('#ai-model').value.trim() : sel) || PROVIDERS[provider].models[0].id,
    effort: $('#ai-effort').value,
    review: $('#ai-review').checked,
    apiKey: $('#ai-key').value.trim(),
    remember: $('#ai-remember').checked,
  };
}
$('#btn-ai-settings').onclick = () => {
  const s = state.ai;
  $('#ai-provider').value = s.provider;
  fillModelList(s.provider, s.model);
  $('#ai-effort').value = s.effort || 'medium';
  $('#ai-review').checked = s.review !== false;
  $('#ai-key').value = s.apiKey || '';
  $('#ai-remember').checked = !!s.remember;
  $('#ai-test-status').textContent = '';
  $('#dlg-ai').showModal();
};
$('#btn-ai-save').onclick = () => {
  state.ai = readAIForm();
  saveSettings(state.ai);
  updateAIIndicators();
  toast('AI設定を保存しました');
};
$('#btn-ai-clear').onclick = () => {
  $('#ai-key').value = '';
  state.ai = { ...readAIForm(), apiKey: '' };
  saveSettings(state.ai);
  updateAIIndicators();
  toast('APIキーを消去しました');
};
$('#btn-ai-test').onclick = async () => {
  const st = $('#ai-test-status');
  st.className = 'status';
  st.textContent = '接続中…';
  try {
    await callLLM(readAIForm(), 'Reply with JSON only.', 'Return {"ok":true}');
    st.className = 'status ok';
    st.textContent = '接続OK';
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.message;
  }
};

// ------------------------------------------------------------------ AI assist (editor)
/** 複数案を横に並べて番号を振った1枚のPNG（AIの見直し用、base64） */
async function makeSheet(comps, cell = 256) {
  try {
    const gap = 16, top = 34;
    const canvas = document.createElement('canvas');
    canvas.width = comps.length * cell + (comps.length + 1) * gap;
    canvas.height = cell + top + gap;
    const ctx = canvas.getContext('2d');
    // 白いアイコンも黒いアイコンも見えるよう中間のグレー背景
    ctx.fillStyle = '#c9ced8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < comps.length; i++) {
      const x = gap + i * (cell + gap);
      const blob = await svgToPNGBlob(exportSVG(comps[i], cell), cell);
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, x, top, cell, cell);
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(String(i + 1), x + 4, 24);
    }
    const out = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch { return null; }
}

/** AIに見せるためのPNG（base64） */
async function compToPNGBase64(comp, size = 384) {
  try {
    const blob = await svgToPNGBlob(exportSVG(comp, size), size);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch { return null; }
}

let assistVariants = [];

function variantThumbHTML(v, i, selectedIdx) {
  const cap = v.idea || v.comp.name;
  const tip = [cap, v.review].filter(Boolean).join('\n');
  return `<button type="button" class="vcard ${i === selectedIdx ? 'selected' : ''}" data-v="${i}" title="${escHTML(tip)}">
    <span class="thumb">${renderSVG(v.comp)}</span><span class="cap">${escHTML(cap)}</span></button>`;
}

function renderAssistVariants() {
  const el = $('#ai-variants');
  el.hidden = !assistVariants.length;
  const sel = assistVariants.findIndex((v) => v.active);
  const note = assistVariants[sel]?.review;
  el.innerHTML = assistVariants.length
    ? `<div class="hint">案をタップするとキャンバスに読み込みます</div><div class="variant-grid">${assistVariants.map((v, i) => variantThumbHTML(v, i, sel)).join('')}</div>${note ? `<p class="review-note">${escHTML(note)}</p>` : ''}`
    : '';
}

function loadAssistVariant(i) {
  const v = assistVariants[i];
  if (!v) return;
  assistVariants.forEach((x, j) => { x.active = j === i; });
  const comp = clone(v.comp);
  if (v.keepName) comp.name = v.keepName;
  state.comp = comp;
  if (v.mode === 'new') state.galleryId = null;
  state.selectedId = null;
  afterLoad();
  record();
  renderAssistVariants();
}
$('#ai-variants').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (b) loadAssistVariant(+b.dataset.v);
});

async function runAssist(mode) {
  const prompt = $('#ai-prompt').value.trim();
  const st = $('#ai-assist-status');
  if (!prompt) return $('#ai-prompt').focus();
  if (!hasKey(state.ai)) { $('#btn-ai-settings').click(); return; }
  if (mode === 'edit' && !state.comp.layers.length) return toast('修正するアイコンがありません。「AIで新規作成」を使ってください');
  const buttons = [$('#btn-ai-new'), $('#btn-ai-edit')];
  buttons.forEach((b) => { b.disabled = true; });
  st.className = 'status';
  try {
    const base = mode === 'edit' ? clone(state.comp) : null;
    const { variants, reviewed } = await aiVariants(state.ai, {
      request: mode === 'edit' ? (base.name || prompt) : prompt,
      instruction: mode === 'edit' ? prompt : '',
      base,
      baseImage: base ? await compToPNGBase64(base) : null,
      makeSheet,
      count: +$('#ai-count').value,
      family: $('#ai-family').value,
      onStatus: (s) => { st.textContent = s; },
    });
    assistVariants = variants.map((v) => ({ ...v, mode, keepName: mode === 'edit' ? base.name : null, active: false }));
    loadAssistVariant(0);
    const skipped = variants.reduce((a, v) => a + v.warnings.length, 0);
    st.className = 'status ok';
    st.textContent = `${variants.length}案できました${reviewed ? '（AI見直し済み）' : ''}${variants.length > 1 ? '。下から選べます' : ''}${skipped ? ` / ${skipped}件のパーツを除外` : ''}`;
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.message;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}
$('#btn-ai-new').onclick = () => runAssist('new');
$('#btn-ai-edit').onclick = () => runAssist('edit');

// ------------------------------------------------------------------ AI batch
// 流れ: ①依頼を書く → ②仕様（スタイルガイド＋各アイコンの解釈）を確認・修正 → ③複数案から選ぶ／派生させる
const batch = {
  step: 'input',
  gf: null,         // スタイルガイドの編集用フラット表現
  items: [],        // {id, request, name, concept, keywords[], question, variants[], selected, status, message, error, instruction, galleryId}
  count: 3,
  extra: '',
  abort: null,
  running: false,
};
$('#batch-bg').insertAdjacentHTML('beforeend', Object.entries(SHAPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join(''));

// アイコンデータ読み込み後に組み立てる（先に作ると未知のアイコンとして除外されるため）
const SAMPLE_DEFS = {
  line: [
    { layers: [{ type: 'icon', icon: 'lucide:mail', x: 46, y: 46, size: 52 }, { type: 'shape', shape: 'circle', x: 70, y: 70, size: 30, halo: 3 }, { type: 'icon', icon: 'lucide:clock', x: 70, y: 70, size: 18 }] },
    { layers: [{ type: 'icon', icon: 'lucide:cloud', x: 46, y: 47, size: 54 }, { type: 'icon', icon: 'lucide:lock', x: 70, y: 70, size: 28, halo: 4 }] },
    { layers: [{ type: 'icon', icon: 'lucide:user', x: 50, y: 50, size: 56 }] },
  ],
  solid: [
    { layers: [{ type: 'icon', icon: 'pinhead:person-sitting-on-bench-with-armrests-and-backrest', x: 50, y: 48, size: 60 }] },
    { layers: [{ type: 'icon', icon: 'pinhead:crowd-of-people', x: 46, y: 46, size: 52 }, { type: 'shape', shape: 'circle', x: 70, y: 70, size: 30, halo: 3, role: 'badge' }, { type: 'icon', icon: 'material-symbols:chat', x: 70, y: 70, size: 18, role: 'badge' }] },
    { layers: [{ type: 'icon', icon: 'pinhead:person-dancing-with-sparkles', x: 50, y: 50, size: 58 }] },
  ],
};
const sampleComps = {};
const getSampleComps = (family) => {
  const f = family === 'solid' ? 'solid' : 'line';
  return (sampleComps[f] ||= SAMPLE_DEFS[f].map((c) => normalizeComposition(c).comp));
};

const fromGuide = (g, unify = true) => ({
  shape: g.background.shape, bgColor: g.background.color, useGrad: !!g.background.color2, color2: g.background.color2 || '#ec4899',
  iconColor: g.iconColor, accentColor: g.accentColor, badgeIconColor: g.badgeIconColor,
  strokeWidth: g.strokeWidth, badgePosition: g.badgePosition, family: g.family || 'auto', notes: g.notes, unify,
});
const toGuide = (f) => normalizeGuide({
  background: { shape: f.shape, color: f.bgColor, color2: f.useGrad ? f.color2 : '' },
  iconColor: f.iconColor, accentColor: f.accentColor, badgeIconColor: f.badgeIconColor,
  strokeWidth: f.strokeWidth, badgePosition: f.badgePosition, family: f.family, notes: f.notes,
});

function batchPrefs() {
  const parts = [];
  const bg = $('#batch-bg').value;
  if (bg === 'none') parts.push('no background (transparent)');
  else if (bg) parts.push(`background shape "${bg}"`);
  if ($('#batch-use-color').checked) parts.push(`main color ${$('#batch-color').value}`);
  const sw = $('#batch-stroke').value;
  if (sw) parts.push(`strokeWidth ${sw}`);
  const fam = $('#batch-family').value;
  if (fam !== 'auto') parts.push(`icon family "${fam}"`);
  const extra = $('#batch-style').value.trim();
  if (extra) parts.push(extra);
  return parts.join('; ');
}

/** 左フォームの明示的な希望をスタイルガイドに上書き */
function applyPrefsToGuide(g) {
  const bg = $('#batch-bg').value;
  if (bg) g.background.shape = bg;
  if ($('#batch-use-color').checked) {
    if (g.background.shape === 'none') g.iconColor = $('#batch-color').value;
    else g.background.color = $('#batch-color').value;
  }
  if ($('#batch-stroke').value) g.strokeWidth = +$('#batch-stroke').value;
  if ($('#batch-family').value !== 'auto') g.family = $('#batch-family').value;
  if (g.background.shape === 'none' && g.iconColor.toLowerCase() === '#ffffff') g.iconColor = '#1f2937';
  return normalizeGuide(g);
}

function readLines() {
  return $('#batch-input').value.split('\n').map((s) => s.trim()).filter(Boolean);
}

function setBatchStep(step) {
  batch.step = step;
  const order = ['input', 'plan', 'results'];
  $$('#batch-steps li').forEach((li) => {
    li.classList.toggle('active', li.dataset.step === step);
    li.classList.toggle('done', order.indexOf(li.dataset.step) < order.indexOf(step));
  });
  renderBatchMain();
  // スマホではフォームの下に表示されるので、そこまでスクロール
  if (isMobile() && step !== 'input') $('#batch-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setBatchRunning(on) {
  batch.running = on;
  $('#btn-batch-plan').disabled = on;
  $('#btn-batch-quick').disabled = on;
  $('#btn-batch-stop').disabled = !on;
  const gen = $('#btn-plan-generate');
  if (gen) gen.disabled = on;
}

function renderBatchMain() {
  const el = $('#batch-main');
  if (batch.step === 'plan') return renderPlanEditor(el);
  if (batch.step === 'results') return renderResults(el);
  el.innerHTML = '<p class="hint">左で依頼を書いて「仕様を作成」を押すと、AIがセット全体のスタイルと各アイコンの解釈を提案します。確認・修正してから生成できます。</p>';
}

// ---- ② 仕様の確認
const GUIDE_FIELDS = [
  { k: 'shape', label: '背景の形', type: 'select', options: { none: 'なし（透明）', ...SHAPES } },
  { k: 'bgColor', label: '背景色', type: 'color' },
  { k: 'useGrad', label: 'グラデーション', type: 'check' },
  { k: 'color2', label: 'グラデ終点', type: 'color' },
  { k: 'iconColor', label: 'メインの色', type: 'color' },
  { k: 'accentColor', label: 'アクセント色', type: 'color' },
  { k: 'badgeIconColor', label: 'バッジ上の色', type: 'color' },
  { k: 'strokeWidth', label: '線の太さ', type: 'range', min: 1, max: 3.5, step: 0.25 },
  { k: 'family', label: '絵柄', type: 'select', options: FAMILIES },
  { k: 'badgePosition', label: 'バッジ位置', type: 'select', options: BADGE_POSITIONS },
  { k: 'notes', label: 'メモ', type: 'text', max: 300 },
  { k: 'unify', label: '自動で揃える', type: 'check' },
].map((f) => ({ ...f, scope: 'guide' }));

function renderGuidePreview() {
  const box = $('#guide-preview');
  if (!box || !batch.gf) return;
  const g = toGuide(batch.gf);
  box.innerHTML = getSampleComps(batch.gf.family).map((c) => `<span class="thumb">${renderSVG(batch.gf.unify ? applyStyleGuide(c, g) : c)}</span>`).join('');
}

function renderPlanEditor(el) {
  const n = batch.items.length;
  el.innerHTML = `
    <div class="row space"><h2>仕様の確認</h2><span class="hint">内容を直してから生成できます</span></div>
    <div class="guide-box">
      <div>
        <div class="hint">スタイルのプレビュー</div>
        <div id="guide-preview" class="guide-preview"></div>
        <p class="hint small">「自動で揃える」がオンだと、AIの出力後に背景・色・線の太さ・バッジ位置をこのガイドに合わせて補正します。</p>
      </div>
      <div id="guide-props" class="props">${GUIDE_FIELDS.map((f) => fieldHTML(f, batch.gf)).join('')}</div>
    </div>
    <h3>各アイコンの解釈（${n}件）</h3>
    <ol class="plan-items">${batch.items.map((it, i) => `
      <li data-idx="${i}">
        <div class="row space"><span class="plan-req">依頼: ${escHTML(it.request)}</span>
          <button type="button" class="btn tiny danger" data-act="remove" title="この件を外す">✕</button></div>
        ${it.question ? `<p class="plan-q">確認: ${escHTML(it.question)}</p>` : ''}
        <label>名前<input type="text" data-f="name" value="${escHTML(it.name)}" maxlength="40"></label>
        <label>内容（モチーフとバッジ）<textarea data-f="concept" rows="2" maxlength="200">${escHTML(it.concept)}</textarea></label>
        <label>アイコンで使う部品（英語の検索語・カンマ区切り。空ならAIが探します）<input type="text" data-f="keywords" value="${escHTML(it.keywords.join(', '))}"></label>
      </li>`).join('')}
    </ol>
    <div class="row">
      <button id="btn-plan-generate" class="btn primary" ${n ? '' : 'disabled'}>この仕様で生成（${n}件 × ${batch.count}案）</button>
      <button id="btn-plan-redo" class="btn">仕様を作り直す</button>
    </div>`;
  bindForm($('#guide-props'), () => batch.gf, GUIDE_FIELDS, (k) => {
    if (k === 'useGrad') $('#guide-props [data-k="color2"]').disabled = !batch.gf.useGrad;
    renderGuidePreview();
  });
  $('#guide-props [data-k="color2"]').disabled = !batch.gf.useGrad;
  renderGuidePreview();
  $('.plan-items', el).addEventListener('input', (e) => {
    const li = e.target.closest('[data-idx]');
    const f = e.target.dataset.f;
    if (!li || !f) return;
    const it = batch.items[+li.dataset.idx];
    it[f] = f === 'keywords' ? e.target.value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean) : e.target.value;
  });
  $('.plan-items', el).addEventListener('click', (e) => {
    const li = e.target.closest('[data-idx]');
    if (li && e.target.closest('[data-act="remove"]')) {
      batch.items.splice(+li.dataset.idx, 1);
      renderPlanEditor(el);
    }
  });
  $('#btn-plan-generate').onclick = () => generateAll();
  $('#btn-plan-redo').onclick = () => $('#btn-batch-plan').click();
  setBatchRunning(batch.running);
}

// ---- ③ 結果（複数案から選ぶ）
function selectedComps() {
  return batch.items.filter((it) => it.variants[it.selected]).map((it) => it.variants[it.selected].comp);
}

function itemHTML(it, i) {
  const sel = it.selected;
  const pending = it.status === 'running' || it.status === 'pending';
  const placeholders = pending && !it.variants.length
    ? Array.from({ length: batch.count }, () => '<span class="vcard placeholder"><span class="thumb"></span><span class="cap">&nbsp;</span></span>').join('')
    : '';
  const status = it.status === 'error' ? `<span class="status err">${escHTML(it.error)}</span>`
    : pending ? `<span class="status" data-role="msg">${escHTML(it.message || '待機中')}</span>` : '';
  const has = !!it.variants[sel];
  return `<section class="ritem ${pending ? 'pending' : ''}" data-idx="${i}">
    <div class="ritem-head">
      <strong>${escHTML(it.name)}</strong>
      <span class="hint">${escHTML(it.concept)}</span>
      ${status}
    </div>
    <div class="variant-grid">${it.variants.map((v, j) => variantThumbHTML(v, j, sel)).join('')}${placeholders}</div>
    ${it.variants[sel]?.review ? `<p class="review-note">${escHTML(it.variants[sel].review)}</p>` : ''}
    <div class="ritem-actions">
      <input type="text" data-f="instruction" value="${escHTML(it.instruction || '')}" placeholder="派生・修正の指示（任意）例: 時計を砂時計に">
      <div class="row">
        <button type="button" class="btn" data-act="derive" ${has && !pending ? '' : 'disabled'} title="選んだ案をもとに、近い方向の案を追加で出します">選んだ案から派生</button>
        <button type="button" class="btn" data-act="regen" ${pending ? 'disabled' : ''}>作り直す</button>
        <button type="button" class="btn primary" data-act="edit" ${has ? '' : 'disabled'}>エディタで編集</button>
        <button type="button" class="btn" data-act="svg" ${has ? '' : 'disabled'}>SVG</button>
      </div>
    </div>
  </section>`;
}

function renderResults(el) {
  const g = toGuide(batch.gf);
  const sw = (c) => `<span class="swatch static" style="background:${c}" title="${c}"></span>`;
  el.innerHTML = `
    <div class="row space">
      <h2>案を選ぶ</h2>
      <div class="row">
        <button id="btn-back-plan" class="btn ghost">仕様に戻る</button>
        <button id="btn-batch-zip" class="btn">選んだ案をZIP</button>
        <button id="btn-batch-save" class="btn">選んだ案をギャラリーへ</button>
      </div>
    </div>
    <div class="guide-summary">
      <span class="hint">スタイル:</span> ${SHAPES[g.background.shape] || 'なし'} ${sw(g.background.color)}${g.background.color2 ? sw(g.background.color2) : ''}
      <span class="hint">メイン</span>${sw(g.iconColor)} <span class="hint">アクセント</span>${sw(g.accentColor)}
      <span class="hint">${FAMILIES[g.family]} / 線 ${g.strokeWidth} / バッジ ${BADGE_POSITIONS[g.badgePosition]} / ${batch.gf.unify ? '自動補正オン' : '自動補正オフ'}</span>
    </div>
    <p class="hint">各アイコンの案をクリックして選んでください。選んだ案が書き出し・保存の対象になります。</p>
    <div class="result-items">${batch.items.map(itemHTML).join('')}</div>`;
  $('#btn-back-plan').onclick = () => setBatchStep('plan');
  $('#btn-batch-zip').onclick = () => zipCompositions(selectedComps(), 'ai-icons.zip');
  $('#btn-batch-save').onclick = () => {
    const items = batch.items.filter((it) => it.variants[it.selected]);
    items.forEach((it) => { it.galleryId = saveToGallery(it.variants[it.selected].comp, it.galleryId); });
    toast(`${items.length}件をギャラリーに保存しました`);
  };
  updateBatchButtons();
}

function renderItem(it) {
  const i = batch.items.indexOf(it);
  const el = $(`#batch-main .ritem[data-idx="${i}"]`);
  if (el) el.outerHTML = itemHTML(it, i);
  updateBatchButtons();
}
function renderItemMessage(it) {
  const el = $(`#batch-main .ritem[data-idx="${batch.items.indexOf(it)}"] [data-role="msg"]`);
  if (el) el.textContent = it.message;
}
function updateBatchButtons() {
  const any = batch.items.some((it) => it.variants[it.selected]);
  ['#btn-batch-zip', '#btn-batch-save'].forEach((s) => { const b = $(s); if (b) b.disabled = !any; });
}

function styleTextFor() {
  let t = describeGuide(toGuide(batch.gf));
  if (batch.items.length > 1) t += `\nThis icon is one of a set of ${batch.items.length} icons; keep the style consistent across the set.`;
  if (batch.extra) t += `\nAdditional style wishes: ${batch.extra}`;
  return t;
}

async function runItem(it, mode, signal) {
  const base = mode === 'derive' ? it.variants[it.selected]?.comp : null;
  it.status = 'running';
  it.message = mode === 'derive' ? '派生案を作成中…' : '開始…';
  it.error = null;
  if (mode !== 'derive') { it.variants = []; it.selected = 0; }
  renderItem(it);
  try {
    const guide = toGuide(batch.gf);
    const r = await aiVariants(state.ai, {
      request: it.request,
      concept: it.concept,
      keywords: it.keywords,
      styleText: styleTextFor(),
      base,
      baseImage: base ? await compToPNGBase64(base) : null,
      makeSheet,
      instruction: mode === 'derive' ? (it.instruction || '').trim() : '',
      count: batch.count,
      family: guide.family,
      signal,
      onStatus: (m) => { it.message = m; renderItemMessage(it); },
    });
    // 見つけた部品は覚えておき、派生・作り直しで再利用する
    if (!it.keywords.length && r.keywords?.length) it.keywords = r.keywords;
    const vs = r.variants.map((v) => {
      const comp = batch.gf.unify ? applyStyleGuide(v.comp, guide) : v.comp;
      comp.name = it.name || comp.name;
      return { comp, idea: v.idea, review: v.review };
    });
    if (mode === 'derive') {
      it.variants.push(...vs);
      it.selected = it.variants.length - vs.length; // 新しい最初の案を選択
    } else {
      it.variants = vs;
      it.selected = 0;
    }
    it.status = 'done';
  } catch (e) {
    it.status = 'error';
    it.error = e.name === 'AbortError' ? '中止しました' : e.message;
  }
  renderItem(it);
}

async function generateAll() {
  if (!hasKey(state.ai)) { $('#btn-ai-settings').click(); return; }
  if (!batch.items.length) return;
  batch.items.forEach((it) => Object.assign(it, { status: 'pending', message: '待機中', variants: [], selected: 0, error: null }));
  setBatchStep('results');
  batch.abort = new AbortController();
  setBatchRunning(true);
  const st = $('#batch-status');
  st.className = 'status';
  let finished = 0;
  const total = batch.items.length;
  st.textContent = `生成中 0 / ${total}`;
  await runPool([...batch.items], +$('#batch-concurrency').value, async (it) => {
    if (batch.abort.signal.aborted) { it.status = 'error'; it.error = '中止しました'; renderItem(it); return; }
    await runItem(it, 'gen', batch.abort.signal);
    st.textContent = `生成中 ${++finished} / ${total}`;
  });
  const ok = batch.items.filter((it) => it.status === 'done').length;
  st.className = ok === total ? 'status ok' : 'status';
  st.textContent = `完了: ${ok} / ${total}件`;
  setBatchRunning(false);
}

const newItem = (p) => ({
  id: uid(), name: p.request.slice(0, 40), concept: p.request, keywords: [], question: '', ...p,
  variants: [], selected: 0, status: 'idle', message: '', error: null, instruction: '', galleryId: null,
});

function readBatchOptions() {
  const lines = readLines();
  if (!lines.length) { $('#batch-input').focus(); return null; }
  if (!hasKey(state.ai)) { $('#btn-ai-settings').click(); return null; }
  if (lines.length > 50) { toast('一度に発注できるのは50件までです', true); return null; }
  batch.count = +$('#batch-count').value;
  batch.extra = $('#batch-style').value.trim();
  return lines;
}

$('#btn-batch-plan').onclick = async () => {
  const lines = readBatchOptions();
  if (!lines) return;
  const st = $('#batch-status');
  st.className = 'status';
  st.textContent = '仕様を作成中…';
  batch.abort = new AbortController();
  setBatchRunning(true);
  try {
    const plan = await aiPlan(state.ai, lines, batchPrefs(), batch.abort.signal);
    const guide = applyPrefsToGuide(normalizeGuide(plan.styleGuide));
    batch.gf = fromGuide(guide, true);
    batch.items = plan.items.map(newItem);
    const qs = batch.items.filter((it) => it.question).length;
    st.className = 'status ok';
    st.textContent = `仕様ができました。右で確認してください${qs ? `（確認事項 ${qs}件）` : ''}`;
    setBatchRunning(false);
    setBatchStep('plan');
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.name === 'AbortError' ? '中止しました' : e.message;
    setBatchRunning(false);
  }
};

$('#btn-batch-quick').onclick = () => {
  const lines = readBatchOptions();
  if (!lines) return;
  batch.gf = fromGuide(applyPrefsToGuide(normalizeGuide({})), true);
  batch.items = lines.map((request) => newItem({ request }));
  generateAll();
};

$('#btn-batch-stop').onclick = () => { batch.abort?.abort(); };

$('#batch-main').addEventListener('input', (e) => {
  if (batch.step !== 'results' || e.target.dataset.f !== 'instruction') return;
  const sec = e.target.closest('.ritem');
  if (sec) batch.items[+sec.dataset.idx].instruction = e.target.value;
});
$('#batch-main').addEventListener('click', async (e) => {
  if (batch.step !== 'results') return;
  const sec = e.target.closest('.ritem');
  if (!sec) return;
  const it = batch.items[+sec.dataset.idx];
  const card = e.target.closest('[data-v]');
  if (card) {
    it.selected = +card.dataset.v;
    renderItem(it);
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const v = it.variants[it.selected];
  if (act === 'edit' && v) { loadComposition(v.comp); switchTab('editor'); }
  if (act === 'svg' && v) downloadBlob(new Blob([exportSVG(v.comp, exportSize())], { type: 'image/svg+xml' }), `${safeName(v.comp.name)}.svg`);
  if (act === 'derive' || act === 'regen') {
    if (!hasKey(state.ai)) return $('#btn-ai-settings').click();
    await runItem(it, act === 'derive' ? 'derive' : 'gen', new AbortController().signal);
  }
});

// ------------------------------------------------------------------ init
async function init() {
  updateAIIndicators();
  $('#gallery-count').textContent = gallery.length;
  try {
    await loadIcons();
  } catch (e) {
    $('#search-hint').textContent = e.message;
    return;
  }
  // 保存済みの作品も検証・サニタイズしてから表示する
  gallery = gallery.filter((g) => g && g.comp).map((g) => ({ ...g, comp: normalizeComposition(g.comp, g.comp.name).comp }));
  renderGallery();
  const setNames = {
    lucide: 'Lucide（線）', tabler: 'Tabler（線）', 'tabler-filled': 'Tabler（塗り）',
    pinhead: 'Pinhead（ピクトグラム）', 'material-symbols': 'Material Symbols（塗り）',
  };
  $('#set-filter').innerHTML = store.sets.map((s) =>
    `<label><input type="checkbox" value="${s.id}" checked> ${setNames[s.id] || s.name} <span class="hint">(${s.license})</span></label>`).join('');
  $('#set-filter').addEventListener('change', runSearch);

  const saved = storageGet('pig.current', null);
  if (saved?.comp) {
    const { comp } = normalizeComposition(saved.comp);
    state.comp = comp;
    state.galleryId = saved.galleryId || null;
  } else {
    // 初回はサンプルを表示
    state.comp = normalizeComposition({
      name: 'サンプル: セキュアなクラウド',
      background: { shape: 'squircle', color: '#6366f1', color2: '#8b5cf6' },
      layers: [
        { type: 'icon', icon: 'lucide:cloud', x: 47, y: 48, size: 56, color: '#ffffff', strokeWidth: 2 },
        { type: 'shape', shape: 'circle', x: 70, y: 70, size: 30, color: '#22c55e', halo: 3, haloColor: '#7c5cf6' },
        { type: 'icon', icon: 'lucide:lock', x: 70, y: 70, size: 18, color: '#ffffff', strokeWidth: 2.5 },
      ],
    }).comp;
  }
  afterLoad();
  record();
  runSearch();
}
init();
