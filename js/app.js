import { store, loadIcons, searchIcons, getIcon, iconPreviewSVG } from './icons.js';
import {
  SHAPES, newComposition, newIconLayer, newShapeLayer, newTextLayer, renderSVG, layerMarkup,
  exportSVG, svgToPNGBlob, normalizeComposition, shapeElement, clone, uid,
} from './compose.js';
import { PROVIDERS, loadSettings, saveSettings, hasKey, aiGenerate, runPool, callLLM } from './ai.js';

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
    out += `<g transform="translate(${s.x} ${s.y}) rotate(${s.rotate || 0})" pointer-events="none">
      <rect x="${-h}" y="${-h}" width="${s.size}" height="${s.size}" fill="none" stroke="var(--accent)" stroke-width="0.5" stroke-dasharray="1.5 1"/>
      <line x1="0" y1="${-h}" x2="0" y2="${-h - 6}" stroke="var(--accent)" stroke-width="0.4"/></g>
      <g transform="translate(${s.x} ${s.y}) rotate(${s.rotate || 0})">
      <circle data-handle="rotate" cx="0" cy="${-h - 6}" r="2.2" fill="var(--panel)" stroke="var(--accent)" stroke-width="0.6" style="cursor:grab"/>
      <rect data-handle="scale" x="${h - 2}" y="${h - 2}" width="4" height="4" rx="0.8" fill="var(--accent)" style="cursor:nwse-resize"/></g>`;
  }
  return out;
}

function renderStage() { stage.innerHTML = stageMarkup(); }
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
stage.addEventListener('pointerdown', (e) => {
  const p = svgPoint(e);
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
    if (state.selectedId) { state.selectedId = null; renderAll(); }
    return;
  }
  stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = svgPoint(e);
  const l = drag.l;
  if (drag.mode === 'move') {
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
  }
  renderStage();
  refreshPropValues();
});
const endDrag = () => {
  if (!drag) return;
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
  const rb = $('#btn-replace', el);
  if (rb) {
    rb.onclick = () => {
      state.replaceMode = !state.replaceMode;
      rb.textContent = state.replaceMode ? '検索結果をクリック…' : '差し替え';
      if (state.replaceMode) { toast('左の検索結果から差し替えるアイコンを選んでください'); $('#q').focus(); }
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

function updateAIIndicators() {
  const on = hasKey(state.ai);
  $('#ai-status-dot').classList.toggle('on', on);
  $('#ai-assist-hint').textContent = on
    ? `${PROVIDERS[state.ai.provider]?.label || state.ai.provider} / ${state.ai.model}`
    : 'AI設定でAPIキーを入れると使えます';
}

function fillModelList(provider) {
  $('#ai-model-list').innerHTML = (PROVIDERS[provider]?.models || []).map((m) => `<option value="${m}">`).join('');
  $('#ai-key').placeholder = PROVIDERS[provider]?.keyHint || '';
}
$('#ai-provider').innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
$('#ai-provider').onchange = (e) => {
  fillModelList(e.target.value);
  $('#ai-model').value = PROVIDERS[e.target.value].models[0];
};
function readAIForm() {
  return {
    provider: $('#ai-provider').value,
    model: $('#ai-model').value.trim() || PROVIDERS[$('#ai-provider').value].models[0],
    apiKey: $('#ai-key').value.trim(),
    remember: $('#ai-remember').checked,
  };
}
$('#btn-ai-settings').onclick = () => {
  const s = state.ai;
  $('#ai-provider').value = s.provider;
  fillModelList(s.provider);
  $('#ai-model').value = s.model;
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
    const { comp, warnings } = await aiGenerate(state.ai, prompt, {
      base: mode === 'edit' ? state.comp : null,
      onStatus: (s) => { st.textContent = s; },
    });
    if (mode === 'edit') {
      comp.name = state.comp.name || comp.name;
      state.comp = comp;
      state.selectedId = null;
      afterLoad();
      record();
    } else {
      loadComposition(comp);
    }
    st.className = 'status ok';
    st.textContent = warnings.length ? `完了（${warnings.length}件のパーツを除外）` : '完了';
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
const batch = { jobs: [], abort: null };
$('#batch-bg').insertAdjacentHTML('beforeend', Object.entries(SHAPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join(''));

function batchStyle(total) {
  const parts = [];
  if (total > 1) parts.push(`This icon is one of a set of ${total} icons; keep the style consistent across the set.`);
  const bg = $('#batch-bg').value;
  if (bg === 'none') parts.push('No background (background.shape = "none").');
  else if (bg) parts.push(`Use background.shape = "${bg}".`);
  if ($('#batch-use-color').checked) parts.push(`Main color: ${$('#batch-color').value} (derive a harmonious palette from it).`);
  const sw = $('#batch-stroke').value;
  if (sw) parts.push(`Use strokeWidth ${sw} for all icon layers.`);
  const extra = $('#batch-style').value.trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

function jobCardHTML(job) {
  const cls = job.status === 'done' ? '' : job.status === 'error' ? 'error' : 'pending';
  const thumb = job.comp ? renderSVG(job.comp) : '';
  const sub = job.status === 'error' ? escHTML(job.error) : job.status === 'done' ? escHTML(job.keywords?.join(', ') || '') : escHTML(job.message || '待機中');
  return `<div class="card ${cls}" data-job="${job.id}">
    <div class="thumb">${thumb}</div>
    <div class="title" title="${escHTML(job.text)}">${escHTML(job.comp?.name || job.text)}</div>
    <div class="sub" title="${sub}">${sub}</div>
    <div class="actions">
      ${job.comp ? '<button class="btn primary" data-act="edit">編集</button><button class="btn" data-act="svg">SVG</button><button class="btn" data-act="save">保存</button>' : ''}
      ${job.status === 'done' || job.status === 'error' ? '<button class="btn" data-act="retry">再生成</button>' : ''}
    </div></div>`;
}
function renderJob(job) {
  const el = $(`[data-job="${job.id}"]`);
  if (el) el.outerHTML = jobCardHTML(job);
}
function updateBatchButtons() {
  const done = batch.jobs.filter((j) => j.comp);
  $('#btn-batch-zip').disabled = !done.length;
  $('#btn-batch-save').disabled = !done.length;
}

async function runJob(job, style, signal) {
  job.status = 'running';
  job.message = '開始…';
  job.error = null;
  renderJob(job);
  try {
    const r = await aiGenerate(state.ai, job.text, {
      style, signal, onStatus: (m) => { job.message = m; renderJob(job); },
    });
    job.comp = r.comp;
    job.keywords = r.keywords;
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.name === 'AbortError' ? '中止しました' : e.message;
  }
  renderJob(job);
  updateBatchButtons();
}

$('#btn-batch-run').onclick = async () => {
  const lines = $('#batch-input').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return $('#batch-input').focus();
  if (!hasKey(state.ai)) { $('#btn-ai-settings').click(); return; }
  if (lines.length > 50) return toast('一度に発注できるのは50件までです', true);
  const style = batchStyle(lines.length);
  batch.jobs = lines.map((text, i) => ({ id: `j${Date.now()}${i}`, text, status: 'pending' }));
  $('#batch-results').innerHTML = batch.jobs.map(jobCardHTML).join('');
  batch.abort = new AbortController();
  $('#btn-batch-run').disabled = true;
  $('#btn-batch-stop').disabled = false;
  updateBatchButtons();
  const st = $('#batch-status');
  st.className = 'status';
  let finished = 0;
  st.textContent = `0 / ${lines.length}`;
  await runPool(batch.jobs, +$('#batch-concurrency').value, async (job) => {
    if (batch.abort.signal.aborted) { job.status = 'error'; job.error = '中止しました'; renderJob(job); return; }
    await runJob(job, style, batch.abort.signal);
    st.textContent = `${++finished} / ${lines.length}`;
  });
  const ok = batch.jobs.filter((j) => j.status === 'done').length;
  st.className = ok === lines.length ? 'status ok' : 'status';
  st.textContent = `完了: ${ok} / ${lines.length}件 成功`;
  $('#btn-batch-run').disabled = false;
  $('#btn-batch-stop').disabled = true;
};
$('#btn-batch-stop').onclick = () => { batch.abort?.abort(); };
$('#batch-results').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-job]');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !act) return;
  const job = batch.jobs.find((j) => j.id === card.dataset.job);
  if (!job) return;
  if (act === 'edit') { loadComposition(job.comp); switchTab('editor'); }
  if (act === 'svg') downloadBlob(new Blob([exportSVG(job.comp, exportSize())], { type: 'image/svg+xml' }), `${safeName(job.comp.name)}.svg`);
  if (act === 'save') { job.galleryId = saveToGallery(job.comp, job.galleryId); toast('ギャラリーに保存しました'); }
  if (act === 'retry') {
    if (!hasKey(state.ai)) return $('#btn-ai-settings').click();
    await runJob(job, batchStyle(batch.jobs.length), new AbortController().signal);
  }
});
$('#btn-batch-zip').onclick = () => zipCompositions(batch.jobs.filter((j) => j.comp).map((j) => j.comp), 'ai-icons.zip');
$('#btn-batch-save').onclick = () => {
  const done = batch.jobs.filter((j) => j.comp);
  done.forEach((j) => { j.galleryId = saveToGallery(j.comp, j.galleryId); });
  toast(`${done.length}件をギャラリーに保存しました`);
};

// ------------------------------------------------------------------ init
async function init() {
  updateAIIndicators();
  $('#gallery-count').textContent = gallery.length;
  renderGallery();
  try {
    await loadIcons();
  } catch (e) {
    $('#search-hint').textContent = e.message;
    return;
  }
  const setNames = { lucide: 'Lucide', tabler: 'Tabler', 'tabler-filled': 'Tabler 塗り' };
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
