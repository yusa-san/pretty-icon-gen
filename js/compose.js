// コンポジション（合成アイコン）のデータモデルとSVGレンダリング
// 座標系: viewBox 0 0 100 100、各レイヤーは中心座標(x,y)と一辺サイズ(size)で表す
import { getIcon } from './icons.js';

export const SHAPES = {
  circle: '円',
  rounded: '角丸',
  squircle: 'スクワクル',
  square: '四角',
  hexagon: '六角形',
  diamond: 'ひし形',
  star: '星',
  shield: '盾',
  bubble: '吹き出し',
};

let seq = 0;
export const uid = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newComposition(name = '新しいアイコン') {
  return {
    version: 1,
    name,
    background: { shape: 'none', color: '#4f46e5', color2: '', size: 100, outline: 0, outlineColor: '#ffffff' },
    layers: [],
  };
}

export function newIconLayer(iconId, opts = {}) {
  return {
    id: uid(), type: 'icon', icon: iconId,
    x: 50, y: 50, size: 60, rotate: 0, flipX: false, flipY: false, opacity: 1,
    color: '#1f2937', strokeWidth: 2, halo: 0, haloColor: '#ffffff', hidden: false,
    ...opts,
  };
}

export function newShapeLayer(shape = 'circle', opts = {}) {
  return {
    id: uid(), type: 'shape', shape,
    x: 72, y: 72, size: 36, rotate: 0, flipX: false, flipY: false, opacity: 1,
    color: '#ef4444', outline: 0, halo: 0, haloColor: '#ffffff', hidden: false,
    ...opts,
  };
}

/**
 * 自由描画レイヤー: AIや手入力のSVG要素をそのまま持つ。
 * markup は 0..100 のキャンバス座標で書かれ、レイヤーの x,y,size で移動・拡大縮小できる
 * （x=50, y=50, size=100 のとき書かれた座標どおりに表示される）。
 */
export function newDrawLayer(markup, opts = {}) {
  return {
    id: uid(), type: 'draw', markup: sanitizeSVGMarkup(markup),
    x: 50, y: 50, size: 100, rotate: 0, flipX: false, flipY: false, opacity: 1,
    halo: 0, haloColor: '#ffffff', hidden: false,
    ...opts,
  };
}

// ---- SVGマークアップのサニタイズ（AIの出力や読み込んだJSONをそのままDOMに入れないため）
const ALLOWED_EL = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const NUMERIC = /^[-+\d.eE%\s,]*$/;
const ATTR_RULES = {
  d: /^[MmLlHhVvCcSsQqTtAaZz\d.,\seE+-]*$/,
  points: NUMERIC,
  transform: /^(\s*(translate|scale|rotate|matrix|skewX|skewY)\(\s*[-+\d.eE,\s]*\)\s*,?)*\s*$/,
  'stroke-linecap': /^(butt|round|square)$/,
  'stroke-linejoin': /^(miter|round|bevel|arcs|miter-clip)$/,
  'fill-rule': /^(nonzero|evenodd)$/,
  'clip-rule': /^(nonzero|evenodd)$/,
  'stroke-dasharray': /^(none|[-+\d.eE%\s,]*)$/,
  fill: 'paint',
  stroke: 'paint',
};
['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'stroke-width',
  'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity'].forEach((a) => { ATTR_RULES[a] = NUMERIC; });
const SAFE_PAINT = /^(none|currentColor|transparent|#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.%\s,]+\))$/i;
const MAX_MARKUP = 60000, MAX_ELEMENTS = 400;

export function sanitizeSVGMarkup(markup) {
  if (!markup || typeof DOMParser === 'undefined') return '';
  const src = String(markup).slice(0, MAX_MARKUP * 2).replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/gi, '');
  // <svg> で包まれていれば中身だけを使う
  const inner = /^\s*<svg[\s>]/i.test(src) ? src.replace(/^\s*<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '') : src;
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return '';
  let count = 0;
  const walk = (el) => {
    let out = '';
    for (const child of el.children) {
      const tag = child.localName;
      if (!ALLOWED_EL.has(tag) || ++count > MAX_ELEMENTS) continue;
      let attrs = '';
      for (const { name, value } of [...child.attributes]) {
        const rule = ATTR_RULES[name];
        const v = value.trim();
        if (!rule || v.length > 20000) continue;
        if (rule === 'paint' ? !SAFE_PAINT.test(v) : !rule.test(v)) continue;
        attrs += ` ${name}="${v.replace(/"/g, '')}"`;
      }
      const kids = tag === 'g' ? walk(child) : '';
      out += tag === 'g' ? `<g${attrs}>${kids}</g>` : `<${tag}${attrs}/>`;
    }
    return out;
  };
  const out = walk(doc.documentElement);
  return out.length > MAX_MARKUP ? '' : out;
}

let measureSvg = null;
/** マークアップの実際の範囲（0..100座標）を測る。DOMが無い環境では null */
export function measureMarkup(markup) {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!measureSvg) {
    measureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    measureSvg.setAttribute('viewBox', '0 0 100 100');
    measureSvg.setAttribute('aria-hidden', 'true');
    measureSvg.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none';
    document.body.appendChild(measureSvg);
  }
  measureSvg.innerHTML = `<g>${markup}</g>`;
  try {
    const b = measureSvg.firstChild.getBBox();
    return b.width || b.height ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
  } catch { return null; } finally { measureSvg.innerHTML = ''; }
}

/**
 * 描画レイヤーの枠を中身にぴったり合わせる（見た目は変えずに x,y,size と markup の座標を付け替える）。
 * これで選択枠・ドラッグ・拡大縮小が中身に対して自然に効く。
 */
export function fitDrawLayer(l) {
  const b = measureMarkup(l.markup);
  if (!b) return l;
  // 線の太さ分の余白
  const pad = 3;
  const S = Math.max(b.w, b.h) + pad * 2;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // 現在の見た目: p' = (l.x - l.size/2) + (l.size/100) * p
  // 新しい枠 (cx', cy', S') で同じ見た目にするための内側変換を求める
  const k0 = l.size / 100, ox0 = l.x - l.size / 2, oy0 = l.y - l.size / 2;
  const nx = ox0 + k0 * cx, ny = oy0 + k0 * cy, nS = k0 * S;
  const k = 100 / S, tx = -(cx - S / 2), ty = -(cy - S / 2);
  l.markup = `<g transform="scale(${n(k)}) translate(${n(tx)} ${n(ty)})">${l.markup}</g>`;
  l.x = n(nx); l.y = n(ny); l.size = n(nS);
  return l;
}

export function newTextLayer(text = 'A', opts = {}) {
  return {
    id: uid(), type: 'text', text,
    x: 50, y: 50, size: 40, rotate: 0, flipX: false, flipY: false, opacity: 1,
    color: '#1f2937', weight: 700, halo: 0, haloColor: '#ffffff', hidden: false,
    ...opts,
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => +(+v).toFixed(3);

/** 原点中心・一辺 s の図形 */
export function shapeElement(shape, s, attrs) {
  const h = s / 2;
  switch (shape) {
    case 'circle': return `<circle cx="0" cy="0" r="${n(h)}" ${attrs}/>`;
    case 'square': return `<rect x="${n(-h)}" y="${n(-h)}" width="${n(s)}" height="${n(s)}" ${attrs}/>`;
    case 'rounded': return `<rect x="${n(-h)}" y="${n(-h)}" width="${n(s)}" height="${n(s)}" rx="${n(s * 0.2)}" ${attrs}/>`;
    case 'squircle': {
      // スーパー楕円風の滑らかな角丸
      const k = h * 0.9;
      const d = `M0 ${n(-h)}C${n(k)} ${n(-h)} ${n(h)} ${n(-k)} ${n(h)} 0S${n(k)} ${n(h)} 0 ${n(h)}S${n(-h)} ${n(k)} ${n(-h)} 0S${n(-k)} ${n(-h)} 0 ${n(-h)}Z`;
      return `<path d="${d}" ${attrs}/>`;
    }
    case 'hexagon': {
      const pts = [...Array(6)].map((_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${n(Math.cos(a) * h)},${n(Math.sin(a) * h)}`;
      });
      return `<polygon points="${pts.join(' ')}" stroke-linejoin="round" ${attrs}/>`;
    }
    case 'diamond': return `<polygon points="0,${n(-h)} ${n(h)},0 0,${n(h)} ${n(-h)},0" stroke-linejoin="round" ${attrs}/>`;
    case 'star': {
      const pts = [...Array(10)].map((_, i) => {
        const r = i % 2 ? h * 0.45 : h;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        return `${n(Math.cos(a) * r)},${n(Math.sin(a) * r + h * 0.06)}`;
      });
      return `<polygon points="${pts.join(' ')}" stroke-linejoin="round" ${attrs}/>`;
    }
    case 'shield': {
      const d = `M0 ${n(-h)}L${n(h * 0.85)} ${n(-h * 0.65)}V${n(-h * 0.05)}C${n(h * 0.85)} ${n(h * 0.5)} ${n(h * 0.45)} ${n(h * 0.85)} 0 ${n(h)}C${n(-h * 0.45)} ${n(h * 0.85)} ${n(-h * 0.85)} ${n(h * 0.5)} ${n(-h * 0.85)} ${n(-h * 0.05)}V${n(-h * 0.65)}Z`;
      return `<path d="${d}" stroke-linejoin="round" ${attrs}/>`;
    }
    case 'bubble': {
      const r = s * 0.18, t = h * 0.7;
      const d = `M${n(-h + r)} ${n(-h)}H${n(h - r)}Q${n(h)} ${n(-h)} ${n(h)} ${n(-h + r)}V${n(t - r)}Q${n(h)} ${n(t)} ${n(h - r)} ${n(t)}H${n(-h * 0.2)}L${n(-h * 0.6)} ${n(h)}V${n(t)}H${n(-h + r)}Q${n(-h)} ${n(t)} ${n(-h)} ${n(t - r)}V${n(-h + r)}Q${n(-h)} ${n(-h)} ${n(-h + r)} ${n(-h)}Z`;
      return `<path d="${d}" stroke-linejoin="round" ${attrs}/>`;
    }
    default: return '';
  }
}

function layerTransform(l) {
  const sx = l.flipX ? -1 : 1, sy = l.flipY ? -1 : 1;
  let t = `translate(${n(l.x)} ${n(l.y)})`;
  if (l.rotate) t += ` rotate(${n(l.rotate)})`;
  if (sx !== 1 || sy !== 1) t += ` scale(${sx} ${sy})`;
  return t;
}

function iconContent(l) {
  const icon = getIcon(l.icon);
  if (!icon) return '';
  const s = l.size, k = s / 24;
  const inner = `transform="translate(${n(-s / 2)} ${n(-s / 2)}) scale(${n(k)})"`;
  const sw = l.strokeWidth ?? 2;
  let out = '';
  if (l.halo > 0) {
    const hw = n((l.halo * 2) / k);
    out += icon.style === 'fill'
      ? `<g ${inner} fill="${l.haloColor}" stroke="${l.haloColor}" stroke-width="${hw}" stroke-linecap="round" stroke-linejoin="round">${icon.body}</g>`
      : `<g ${inner} fill="none" stroke="${l.haloColor}" stroke-width="${n(sw + hw)}" stroke-linecap="round" stroke-linejoin="round">${icon.body}</g>`;
  }
  out += icon.style === 'fill'
    ? `<g ${inner} fill="${l.color}" stroke="none">${icon.body}</g>`
    : `<g ${inner} fill="none" stroke="${l.color}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round">${icon.body}</g>`;
  return out;
}

function shapeContent(l) {
  let out = '';
  const outline = +l.outline || 0;
  if (l.halo > 0) {
    out += shapeElement(l.shape, l.size, `fill="${l.haloColor}" stroke="${l.haloColor}" stroke-width="${n(l.halo * 2)}"`);
  }
  out += outline > 0
    ? shapeElement(l.shape, l.size - outline, `fill="none" stroke="${l.color}" stroke-width="${n(outline)}"`)
    : shapeElement(l.shape, l.size, `fill="${l.color}"`);
  return out;
}

function textContent(l) {
  const base = `x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',system-ui,sans-serif" font-size="${n(l.size)}" font-weight="${l.weight || 700}"`;
  let out = '';
  if (l.halo > 0) {
    out += `<text ${base} fill="${l.haloColor}" stroke="${l.haloColor}" stroke-width="${n(l.halo * 2)}" stroke-linejoin="round">${esc(l.text)}</text>`;
  }
  out += `<text ${base} fill="${l.color}">${esc(l.text)}</text>`;
  return out;
}

function drawContent(l) {
  const s = l.size, k = s / 100;
  return `<g transform="translate(${n(-s / 2)} ${n(-s / 2)}) scale(${n(k)})">${l.markup || ''}</g>`;
}

export function layerMarkup(l) {
  if (l.hidden) return '';
  const content = l.type === 'icon' ? iconContent(l) : l.type === 'shape' ? shapeContent(l)
    : l.type === 'draw' ? drawContent(l) : textContent(l);
  const op = l.opacity != null && l.opacity < 1 ? ` opacity="${n(l.opacity)}"` : '';
  return `<g transform="${layerTransform(l)}"${op} data-layer="${l.id}">${content}</g>`;
}

let gradSeq = 0;
function backgroundMarkup(bg) {
  if (!bg || bg.shape === 'none') return { defs: '', body: '' };
  let fill = bg.color, defs = '';
  if (bg.color2) {
    const id = `pig-grad-${gradSeq++}`;
    defs = `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg.color}"/><stop offset="1" stop-color="${bg.color2}"/></linearGradient>`;
    fill = `url(#${id})`;
  }
  const size = bg.size || 100;
  const ow = +bg.outline || 0;
  const attrs = ow > 0
    ? `fill="${fill}" stroke="${bg.outlineColor || '#fff'}" stroke-width="${n(ow)}"`
    : `fill="${fill}"`;
  return { defs, body: `<g transform="translate(50 50)">${shapeElement(bg.shape, size - ow, attrs)}</g>` };
}

/** コンポジション→SVG文字列 */
export function renderSVG(comp, { width = null, height = null, extra = '' } = {}) {
  const bg = backgroundMarkup(comp.background);
  const wh = width ? ` width="${width}" height="${height || width}"` : '';
  const body = comp.layers.map(layerMarkup).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${wh}>${bg.defs ? `<defs>${bg.defs}</defs>` : ''}${bg.body}${body}${extra}</svg>`;
}

/** ダウンロード用のSVG（メタ情報付き） */
export function exportSVG(comp, size = 512) {
  const svg = renderSVG(comp, { width: size, height: size });
  const used = [...new Set(comp.layers.filter((l) => l.type === 'icon').map((l) => l.icon.split(':')[0]))];
  const credit = used.length ? `<!-- Made with pretty-icon-gen. Source icons: ${used.map((s) => (s.startsWith('tabler') ? 'Tabler Icons (MIT)' : 'Lucide (ISC)')).filter((v, i, a) => a.indexOf(v) === i).join(', ')} -->\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${credit}${svg}\n`;
}

export function svgToPNGBlob(svgString, size = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG変換に失敗しました'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVGの読み込みに失敗しました')); };
    img.src = url;
  });
}

const clamp = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const color = (v, d) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : d);

/** 外部（AIの出力やJSON読み込み）からのコンポジションを検証・補正する */
export function normalizeComposition(raw, fallbackName = 'アイコン') {
  const comp = newComposition(String(raw?.name || fallbackName).slice(0, 80));
  const b = raw?.background || {};
  comp.background = {
    shape: SHAPES[b.shape] ? b.shape : 'none',
    color: color(b.color, '#4f46e5'),
    color2: b.color2 ? color(b.color2, '') : '',
    size: clamp(b.size, 10, 100, 100),
    outline: clamp(b.outline, 0, 20, 0),
    outlineColor: color(b.outlineColor, '#ffffff'),
  };
  const warnings = [];
  for (const l of Array.isArray(raw?.layers) ? raw.layers.slice(0, 30) : []) {
    const common = {
      x: clamp(l.x, -20, 120, 50), y: clamp(l.y, -20, 120, 50), size: clamp(l.size, 2, 200, 40),
      rotate: clamp(l.rotate, -360, 360, 0), opacity: clamp(l.opacity, 0, 1, 1),
      flipX: !!l.flipX, flipY: !!l.flipY,
      halo: clamp(l.halo, 0, 20, 0), haloColor: color(l.haloColor, '#ffffff'),
      // AIが付ける役割（スタイル統一で使う）: main / detail / badge
      ...(['main', 'detail', 'badge'].includes(l.role) ? { role: l.role } : {}),
    };
    if (l.type === 'icon' || (!l.type && l.icon)) {
      if (!getIcon(l.icon)) { warnings.push(`不明なアイコン: ${l.icon}`); continue; }
      comp.layers.push(newIconLayer(l.icon, { ...common, color: color(l.color, '#1f2937'), strokeWidth: clamp(l.strokeWidth, 0.25, 6, 2) }));
    } else if (l.type === 'shape') {
      comp.layers.push(newShapeLayer(SHAPES[l.shape] ? l.shape : 'circle', { ...common, color: color(l.color, '#ef4444'), outline: clamp(l.outline, 0, 30, 0) }));
    } else if (l.type === 'text' && l.text) {
      comp.layers.push(newTextLayer(String(l.text).slice(0, 12), { ...common, color: color(l.color, '#1f2937'), weight: clamp(l.weight, 100, 900, 700) }));
    } else if (l.type === 'draw') {
      const markup = sanitizeSVGMarkup(l.markup);
      if (!markup) { warnings.push('描画レイヤーのSVGを読み取れませんでした'); continue; }
      const layer = newDrawLayer(markup, {
        ...common, size: clamp(l.size, 2, 200, 100), x: clamp(l.x, -20, 120, 50), y: clamp(l.y, -20, 120, 50), halo: 0,
      });
      // キャンバス全体サイズのまま（AIの出力の既定）なら中身に合わせる
      if (layer.size === 100 && layer.x === 50 && layer.y === 50 && !layer.rotate) fitDrawLayer(layer);
      comp.layers.push(layer);
    }
  }
  return { comp, warnings };
}

/** AIに渡すためのコンパクトなJSON表現 */
export function compactComposition(comp) {
  const r = (v) => Math.round(v * 10) / 10;
  return {
    name: comp.name,
    background: comp.background,
    layers: comp.layers.map(({ id, hidden, ...l }) => {
      for (const k of ['x', 'y', 'size', 'rotate']) l[k] = r(l[k]);
      return l;
    }),
  };
}

export const clone = (o) => JSON.parse(JSON.stringify(o));
