// 生成AIアシスト: ブラウザから各社APIを直接呼び出す（APIキーはユーザーのブラウザ内にのみ保持）
import { searchIcons, getIcon } from './icons.js';
import { normalizeComposition, compactComposition, SHAPES } from './compose.js';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（速い・安い）' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（バランス）' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（高性能・高い）' },
    ],
    keyHint: 'sk-ant-...',
    supportsEffort: true,
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    ],
    keyHint: 'sk-...',
  },
  gemini: {
    label: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    keyHint: 'AIza...',
  },
};

export const EFFORTS = { low: '浅め（速い）', medium: '標準', high: '深め（遅い・高い）' };

const SETTINGS_KEY = 'pig.ai.settings';
const SETTINGS_VERSION = 2;

export function defaultSettings() {
  return { v: SETTINGS_VERSION, provider: 'anthropic', model: PROVIDERS.anthropic.models[0].id, effort: 'medium', apiKey: '', remember: false };
}

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || sessionStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) {
      // v1 の既定値だった Opus は、新しい既定の Haiku に移行する
      if (!s.v && s.model === 'claude-opus-5-5') s.model = 'claude-haiku-5-5';
      return { ...defaultSettings(), ...s, v: SETTINGS_VERSION };
    }
  } catch { /* ignore */ }
  return defaultSettings();
}

export function saveSettings(s) {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    sessionStorage.removeItem(SETTINGS_KEY);
    (s.remember ? localStorage : sessionStorage).setItem(SETTINGS_KEY, JSON.stringify({ ...s, v: SETTINGS_VERSION }));
  } catch { /* ignore */ }
}

export const hasKey = (s) => !!(s && s.apiKey && s.apiKey.trim());

export function modelLabel(s) {
  const m = PROVIDERS[s.provider]?.models.find((x) => x.id === s.model);
  return m ? m.label.replace(/（.*）/, '') : s.model;
}

async function readError(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    msg += `: ${j.error?.message || j.message || JSON.stringify(j).slice(0, 300)}`;
  } catch { /* ignore */ }
  return new Error(`APIエラー ${msg}`);
}

async function callAnthropic(s, system, user, signal, image) {
  const model = s.model || 'claude-haiku-5-5';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': s.apiKey.trim(),
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }, { type: 'text', text: user }]
    : user;
  const body = {
    model,
    max_tokens: 32000,
    system,
    output_config: { effort: EFFORTS[s.effort] ? s.effort : 'medium' },
    messages: [{ role: 'user', content }],
  };
  // 安全分類器による拒否時に自動で別モデルへフォールバック（Opus/Sonnet/Fable系のみ対応）
  if (/^claude-(opus|sonnet|fable)-5/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  if (j.stop_reason === 'refusal') throw new Error('AIがこのリクエストを拒否しました。内容を変えて再度お試しください。');
  if (j.stop_reason === 'max_tokens') throw new Error('AIの出力が長すぎて途中で切れました。案の数を減らしてください。');
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(s, system, user, signal, image) {
  const content = image
    ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }, { type: 'text', text: user }]
    : user;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey.trim()}` },
    body: JSON.stringify({
      model: s.model || 'gpt-5-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
    signal,
  });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

async function callGemini(s, system, user, signal, image) {
  const model = encodeURIComponent(s.model || 'gemini-2.5-flash');
  const parts = image ? [{ inline_data: { mime_type: 'image/png', data: image } }, { text: user }] : [{ text: user }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': s.apiKey.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal,
  });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

/**
 * @param {string} [image] 参考画像（PNGのbase64、data:なし）
 */
export async function callLLM(settings, system, user, signal, image = null) {
  if (!hasKey(settings)) throw new Error('APIキーが設定されていません（右上の「AI設定」から入力してください）');
  const fn = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini }[settings.provider];
  if (!fn) throw new Error(`未対応のプロバイダです: ${settings.provider}`);
  return fn(settings, system, user, signal, image);
}

export function extractJSON(text) {
  const t = String(text).replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AIの応答からJSONを読み取れませんでした');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------- プロンプト ----------

const PLAN_SYSTEM = `You are the art director for a set of icons. Each icon will be drawn as SVG on a 100x100 canvas by a designer (who may draw shapes directly or adapt open-source line icons).
You receive a list of icon requests (often in Japanese) and optional style preferences.
Produce:
1) One style guide for the whole set so the icons look consistent.
2) For EACH request, in the same order, a concrete visual interpretation.

Respond with JSON only:
{
 "styleGuide": {
  "background": {"shape": "none|${Object.keys(SHAPES).join('|')}", "color": "#hex", "color2": "#hex or empty"},
  "iconColor": "#hex (main motif; must contrast with background)",
  "accentColor": "#hex (badges / modifier shapes)",
  "badgeIconColor": "#hex (icon drawn on top of an accent shape)",
  "strokeWidth": 1.5-2.5,
  "badgePosition": "br|bl|tr|tl|auto",
  "notes": "short Japanese notes about the visual direction"
 },
 "items": [
  {"name": "short Japanese name", "concept": "Japanese description of what to draw: the main motif, its key visual details, and any badge, e.g. 封筒（フラップが見える）＋右下に時計のバッジ", "keywords": ["english", "keywords", "for", "reference", "icons"], "question": "only if the request is genuinely ambiguous: a short Japanese note on the interpretation you chose and the alternative; otherwise empty"}
 ]
}
Rules: items must have exactly one entry per request, in order. 3-8 keywords each (English, icon-library vocabulary). Honor the user's style preferences when given.`;

const VARIANTS_SYSTEM = `You are a skilled icon designer who draws SVG icons by hand. You design icons on a 100x100 canvas.

You produce a composition made of layers (drawn in array order, first = bottom):
- {"type":"draw","markup":"<path .../><circle .../>"}  ← YOUR MAIN TOOL. Raw SVG elements drawn directly in canvas coordinates (0..100, origin top-left).
  Allowed elements: g, path, circle, ellipse, rect, line, polyline, polygon. Allowed attributes: geometry, fill, stroke, stroke-width, stroke-linecap, stroke-linejoin, fill-rule, opacity, transform. No gradients, filters, text, images or url(...).
  You may split the design into several draw layers (e.g. main motif, badge) so the user can move them separately.
- {"type":"icon","icon":"<reference icon id>","x":50,"y":50,"size":60,"color":"#hex","strokeWidth":2,"halo":0,"haloColor":"#hex"}  Places a library icon as-is (x,y = center, size = box size; source is 24x24). Use only when a reference icon fits perfectly unchanged.
- {"type":"shape","shape":"${Object.keys(SHAPES).join('|')}","x":..,"y":..,"size":..,"color":"#hex","outline":0,"halo":0,"haloColor":"#hex"}
- {"type":"text","text":"AB","x":..,"y":..,"size":..,"color":"#hex","weight":700}  (max ~3 characters; avoid unless asked)

Background: {"shape":"none|${Object.keys(SHAPES).join('|')}","color":"#hex","color2":"#hex or empty"}

How to draw well:
- Think about the request first: what must the viewer recognize instantly? Draw exactly that, with the few details that make it unambiguous.
- Reference icons (24x24, with their SVG) are provided. Feel free to copy their paths into a draw layer and adapt them: scale them with transform="translate(tx ty) scale(k)" (k ≈ desired size / 24), modify or combine paths, remove parts, add details. Do not invent icon ids.
- Line style (default): fill="none", stroke color, stroke-linecap="round", stroke-linejoin="round". Inside a transform with scale k, use stroke-width ≈ desired visual width / k. Visual line width in canvas units should be about (style strokeWidth × 2.2), e.g. strokeWidth 2 → ~4.5 units, consistently across the icon.
- Keep the main motif within about 18..82 (with a background shape) or 8..92 (no background). Badges: about 26-34 units, in the requested corner, usually a filled accent circle with a small white glyph, separated from the motif by a ring in the background color (draw a slightly larger circle in the background color first).
- Simple, bold, legible at 24px. Avoid tiny details and thin hairlines.
- Follow the style guide colors exactly.

When asked for several variants, make them meaningfully different (different metaphor, viewpoint, composition or badge) — not just color changes.

Respond with JSON only: {"variants":[{"name":"short Japanese name","idea":"one short Japanese sentence describing this variant","background":{...},"layers":[...]}]}`;

/** ローカル検索で参考アイコンを集める（AI呼び出しなし） */
function referenceIcons(texts, extraIds = [], limit = 24) {
  const seen = new Set();
  const out = [];
  const push = (icon) => { if (icon && !seen.has(icon.id)) { seen.add(icon.id); out.push(icon); } };
  extraIds.forEach((id) => push(getIcon(id)));
  for (const t of texts.filter(Boolean)) {
    searchIcons(t, { sets: ['lucide', 'tabler'], limit: 6 }).forEach(push);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

const describeRef = (icon) => `${icon.id}${icon.style === 'fill' ? ' [filled]' : ''} (${icon.tags.slice(0, 5).join(', ')}): ${icon.body}`;

/**
 * 仕様の作成（AI 1回）: セット全体のスタイルガイドと、各依頼の解釈
 * @returns {Promise<{styleGuide: object, items: Array<{request,name,concept,keywords,question}>}>}
 */
export async function aiPlan(settings, requests, prefs = '', signal) {
  let user = `Icon requests (${requests.length}):\n${requests.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`;
  if (prefs) user += `\nStyle preferences from the user: ${prefs}\n`;
  const raw = extractJSON(await callLLM(settings, PLAN_SYSTEM, user, signal));
  const items = requests.map((request, i) => {
    const it = (Array.isArray(raw.items) ? raw.items[i] : null) || {};
    return {
      request,
      name: String(it.name || request).slice(0, 40),
      concept: String(it.concept || request).slice(0, 200),
      keywords: (Array.isArray(it.keywords) ? it.keywords : []).map(String).filter(Boolean).slice(0, 12),
      question: String(it.question || '').slice(0, 200),
    };
  });
  return { styleGuide: raw.styleGuide || {}, items };
}

/**
 * 複数案の生成（AI 1回）。AIはSVGを直接描く（参考アイコンを流用・改変してもよい）
 * @param {object} p
 * @param {string} p.request 依頼文
 * @param {string} [p.concept] 仕様で確定した解釈
 * @param {string[]} [p.keywords] 参考アイコンの検索語
 * @param {string} [p.styleText] スタイルの指示（スタイルガイドの説明など）
 * @param {object} [p.base] 元にするコンポジション（修正・派生）
 * @param {string} [p.baseImage] base の見た目（PNGのbase64）
 * @param {string} [p.instruction] 修正・派生の指示
 * @param {number} [p.count] 案の数
 * @returns {Promise<{variants: Array<{comp, idea, warnings}>}>}
 */
export async function aiVariants(settings, p) {
  const { request, concept = '', keywords = [], styleText = '', base = null, baseImage = null, instruction = '', count = 3, signal, onStatus } = p;
  const baseIds = base ? base.layers.filter((l) => l.type === 'icon').map((l) => l.icon) : [];
  const refs = referenceIcons([request, concept, instruction, ...keywords], baseIds);

  onStatus?.(`AIが${count > 1 ? `${count}案を` : ''}描いています…`);
  let user = `Request: ${request}\n`;
  if (concept && concept !== request) user += `Agreed interpretation (follow this): ${concept}\n`;
  if (styleText) user += `${styleText}\n`;
  if (base) {
    user += `\nThe attached image shows the current design. Its composition JSON:\n${JSON.stringify(compactComposition(base))}\n`;
    user += instruction
      ? `Modify it according to this instruction (keep everything that is not asked to change): ${instruction}\n`
      : 'Create variations that stay close to this design direction (alternative details, metaphor, badge or layout).\n';
  }
  user += `\nCreate exactly ${count} variant${count > 1 ? 's' : ''}.\n`;
  if (refs.length) user += `\nReference icons (24x24 line icons unless [filled]; id (tags): svg):\n${refs.map(describeRef).join('\n')}`;

  const raw = extractJSON(await callLLM(settings, VARIANTS_SYSTEM, user, signal, base ? baseImage : null));
  const list = Array.isArray(raw.variants) ? raw.variants : [raw];
  const variants = [];
  for (const v of list.slice(0, count)) {
    const { comp, warnings } = normalizeComposition(v, request.slice(0, 30));
    if (comp.layers.length) variants.push({ comp, idea: String(v.idea || '').slice(0, 120), warnings });
  }
  if (!variants.length) throw new Error('AIが有効な案を返しませんでした');
  return { variants };
}

/** 並列数を制限して実行 */
export async function runPool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}
