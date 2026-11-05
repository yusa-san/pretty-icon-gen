// アイコンデータの読み込みと検索
import { JA_DICT } from './ja-dict.js';

export const store = {
  sets: [],
  icons: [],      // {id, set, name, tags[], body, style}
  byId: new Map(),
};

export async function loadIcons(url = 'data/icons.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`アイコンデータの読み込みに失敗しました (${res.status})`);
  const data = await res.json();
  store.sets = data.sets;
  store.icons = data.icons.map(([si, name, tags, body]) => {
    const set = data.sets[si];
    const icon = {
      id: `${set.id}:${name}`,
      set: set.id,
      name,
      words: name.split('-'),
      tags: tags ? tags.toLowerCase().split(',') : [],
      body,
      style: set.style,
    };
    return icon;
  });
  store.byId = new Map(store.icons.map((i) => [i.id, i]));
  return store;
}

export const getIcon = (id) => store.byId.get(id);

const JA_KEYS = Object.keys(JA_DICT).sort((a, b) => b.length - a.length);
const isAscii = (s) => /^[\x00-\x7f]+$/.test(s);

/** 検索語を英語のタグ候補に展開する */
export function expandQuery(q) {
  const terms = new Map(); // term -> weight
  const add = (t, w) => {
    t = t.toLowerCase().trim();
    if (!t) return;
    terms.set(t, Math.max(terms.get(t) || 0, w));
  };
  const tokens = q.toLowerCase().split(/[\s、。,，・/／]+/).filter(Boolean);
  for (const tok of tokens) {
    if (isAscii(tok)) {
      add(tok, 1);
      if (tok.length > 3 && tok.endsWith('s')) add(tok.slice(0, -1), 0.9);
      if (JA_DICT[tok]) JA_DICT[tok].forEach((t) => add(t, 0.9));
      continue;
    }
    const exact = JA_DICT[tok];
    if (exact) exact.forEach((t, i) => add(t, 1 - i * 0.05));
    // 辞書キーを部分一致で探す（長いキー優先・重複区間は除外）
    // 完全一致した語も構成要素に分解して補助的に検索（例: ユーザー追加 → ユーザー + 追加）
    const partWeight = exact ? 0.5 : 0.9;
    let rest = tok;
    for (const key of JA_KEYS) {
      if (key !== tok && rest.includes(key)) {
        JA_DICT[key].forEach((t, i) => add(t, partWeight - i * 0.05));
        rest = rest.split(key).join('\u0000');
      }
    }
  }
  return [...terms.entries()].map(([term, weight]) => ({ term, weight }));
}

function scoreIcon(icon, term) {
  const { name, words, tags } = icon;
  if (name === term) return 100;
  if (words.includes(term)) return words[0] === term ? 60 : 45;
  if (term.includes('-') && name.startsWith(term)) return 50;
  let s = 0;
  if (term.length >= 4 && words.some((w) => w.startsWith(term))) s = 22;
  for (const t of tags) {
    if (t === term) { s = Math.max(s, 30); break; }
    if (term.length >= 3 && t.split(/[-\s]/).some((w) => w === term || (term.length >= 4 && w.startsWith(term)))) s = Math.max(s, 12);
  }
  return s;
}

/**
 * アイコンを検索する
 * @returns {Array} アイコン配列（スコア順）
 */
export function searchIcons(q, { sets = null, limit = 400 } = {}) {
  const pool = sets ? store.icons.filter((i) => sets.includes(i.set)) : store.icons;
  const terms = expandQuery(q || '');
  if (!terms.length) return pool.slice(0, limit);
  const scored = [];
  for (const icon of pool) {
    let s = 0;
    for (const { term, weight } of terms) s += scoreIcon(icon, term) * weight;
    if (s > 0) {
      // 修飾付き（-off, -x など）の派生アイコンは少し下げる
      s -= icon.words.length * 0.5;
      scored.push([s, icon]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((x) => x[1]);
}

/** 単体アイコンのSVG文字列（プレビュー用） */
export function iconPreviewSVG(icon, color = 'currentColor') {
  const paint = icon.style === 'fill'
    ? `fill="${color}" stroke="none"`
    : `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${paint}>${icon.body}</svg>`;
}
