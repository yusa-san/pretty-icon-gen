// 生成AIアシスト: ブラウザから各社APIを直接呼び出す（APIキーはユーザーのブラウザ内にのみ保持）
import { searchIcons, getIcon } from './icons.js';
import { normalizeComposition, compactComposition, SHAPES } from './compose.js';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyHint: 'sk-ant-...',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1-mini'],
    keyHint: 'sk-...',
  },
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyHint: 'AIza...',
  },
};

const SETTINGS_KEY = 'pig.ai.settings';

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || sessionStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) return s;
  } catch { /* ignore */ }
  return { provider: 'anthropic', model: PROVIDERS.anthropic.models[0], apiKey: '', remember: false };
}

export function saveSettings(s) {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    sessionStorage.removeItem(SETTINGS_KEY);
    (s.remember ? localStorage : sessionStorage).setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

export const hasKey = (s) => !!(s && s.apiKey && s.apiKey.trim());

async function readError(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    msg += `: ${j.error?.message || j.message || JSON.stringify(j).slice(0, 300)}`;
  } catch { /* ignore */ }
  return new Error(`APIエラー ${msg}`);
}

async function callAnthropic(s, system, user, signal) {
  const model = s.model || 'claude-opus-5-5';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': s.apiKey.trim(),
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 16000,
    system,
    // アイコン構成は軽いタスクなので effort は low（コストと待ち時間を抑える）
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: user }],
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
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(s, system, user, signal) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey.trim()}` },
    body: JSON.stringify({
      model: s.model || 'gpt-5-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal,
  });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

async function callGemini(s, system, user, signal) {
  const model = encodeURIComponent(s.model || 'gemini-2.5-flash');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': s.apiKey.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal,
  });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

export async function callLLM(settings, system, user, signal) {
  if (!hasKey(settings)) throw new Error('APIキーが設定されていません（右上の「AI設定」から入力してください）');
  const fn = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini }[settings.provider];
  if (!fn) throw new Error(`未対応のプロバイダです: ${settings.provider}`);
  return fn(settings, system, user, signal);
}

export function extractJSON(text) {
  const t = String(text).replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AIの応答からJSONを読み取れませんでした');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------- プロンプト ----------

const KEYWORD_SYSTEM = `You help build icons by combining existing SVG icons from the Lucide and Tabler icon libraries.
Given a request (often in Japanese), list short English search keywords that would find suitable source icons.
Think about: the main subject, any modifier/badge concept (e.g. plus, check, lock, warning, time), and alternatives/synonyms.
Use icon-library vocabulary (e.g. "user", "file", "shield", "cart", "bolt", "heart", "cloud", "settings").
Respond with JSON only: {"keywords": ["...", "..."]} with 4-12 keywords, most important first.`;

const COMPOSE_SYSTEM = `You are an icon designer. You create a new icon by composing existing SVG source icons, basic shapes and short text on a 100x100 canvas.

Coordinate system: x,y is the CENTER of each layer (0..100, origin top-left); "size" is the width/height of the layer's square box.
Layers are drawn in array order (first = bottom).

Layer types:
- {"type":"icon","icon":"<id from candidate list>","x":50,"y":50,"size":60,"rotate":0,"flipX":false,"color":"#hex","strokeWidth":2,"halo":0,"haloColor":"#hex"}
  Source icons are 24x24 line icons (unless marked [filled]). strokeWidth is in source-icon units (1.5-2.5 typical).
- {"type":"shape","shape":"${Object.keys(SHAPES).join('|')}","x":..,"y":..,"size":..,"color":"#hex","outline":0,"halo":0,"haloColor":"#hex"}  (outline>0 draws only an outline of that width)
- {"type":"text","text":"AB","x":..,"y":..,"size":..,"color":"#hex","weight":700,"halo":0,"haloColor":"#hex"}  (max ~3 characters, use sparingly)
"halo" draws a knock-out border of that width around the layer in haloColor — use it (3-5) on badges/overlapping icons with haloColor equal to the color behind them so they read clearly.

Background: {"shape":"none|${Object.keys(SHAPES).join('|')}","color":"#hex","color2":"#hex or empty for no gradient","size":100,"outline":0,"outlineColor":"#hex"}

Design guidelines:
- Keep it simple and legible at small sizes: usually 1 main icon plus at most 1-2 modifiers.
- Main icon: size 50-65 near the center (with a background shape, ~45-55 so it has padding).
- Modifier/badge: size 28-40 in a corner (commonly bottom-right around x=70,y=70), often on a small filled circle shape with a halo.
- Keep everything inside roughly 6..94.
- Use a harmonious palette with good contrast (icon color vs background).
- Use ONLY icon ids from the candidate list. Never invent ids.

Respond with JSON only: {"name":"short Japanese name","background":{...},"layers":[...]}`;

function candidateList(keywords, extraIds = []) {
  const seen = new Set();
  const out = [];
  const push = (icon) => { if (icon && !seen.has(icon.id)) { seen.add(icon.id); out.push(icon); } };
  extraIds.forEach((id) => push(getIcon(id)));
  for (const kw of keywords) {
    // 塗りアイコンは少なめに
    searchIcons(kw, { sets: ['lucide', 'tabler'], limit: 7 }).forEach(push);
    searchIcons(kw, { sets: ['tabler-filled'], limit: 2 }).forEach(push);
    if (out.length >= 90) break;
  }
  return out.slice(0, 90);
}

const describe = (icon) => `${icon.id}${icon.style === 'fill' ? ' [filled]' : ''} — ${icon.tags.slice(0, 6).join(', ')}`;

/**
 * 1つのアイコンをAIで生成（base を渡すと既存コンポジションの修正）
 * @returns {Promise<{comp, warnings, keywords}>}
 */
export async function aiGenerate(settings, request, { style = '', base = null, signal, onStatus } = {}) {
  onStatus?.('キーワードを考えています…');
  const kwText = await callLLM(settings, KEYWORD_SYSTEM,
    `Request: ${request}${base ? `\nCurrent icon (being edited): ${base.name}` : ''}`, signal);
  let keywords = [];
  try { keywords = extractJSON(kwText).keywords || []; } catch { /* fall back below */ }
  keywords = keywords.map(String).filter(Boolean).slice(0, 12);
  if (!keywords.length) keywords = request.split(/\s+/);

  const baseIds = base ? base.layers.filter((l) => l.type === 'icon').map((l) => l.icon) : [];
  const cands = candidateList(keywords, baseIds);
  if (!cands.length) throw new Error('候補アイコンが見つかりませんでした');

  onStatus?.(`${cands.length}個の候補から構成中…`);
  let user = `Request: ${request}\n`;
  if (style) user += `Style requirements (apply to the whole set): ${style}\n`;
  if (base) user += `\nModify this existing icon according to the request (keep what is not asked to change):\n${JSON.stringify(compactComposition(base))}\n`;
  user += `\nCandidate source icons (id — tags):\n${cands.map(describe).join('\n')}`;

  const text = await callLLM(settings, COMPOSE_SYSTEM, user, signal);
  const raw = extractJSON(text);
  const { comp, warnings } = normalizeComposition(raw, request.slice(0, 30));
  if (!comp.layers.length) throw new Error('AIが有効なレイヤーを返しませんでした');
  return { comp, warnings, keywords };
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
