// スタイルガイド: アイコンセット全体の見た目を揃えるためのルールと、その自動適用
import { SHAPES, clone } from './compose.js';
import { getIcon } from './icons.js';

export const BADGE_POSITIONS = { auto: 'おまかせ', br: '右下', bl: '左下', tr: '右上', tl: '左上' };
// 絵柄の系統: 線のアイコン（Lucide / Tabler）か、塗りのピクトグラム（Pinhead / Material Symbols / Tabler 塗り）か
export const FAMILIES = { auto: 'おまかせ', line: '線のアイコン', solid: '塗りのピクトグラム' };

const color = (v, d) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : d);
const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

export function defaultGuide() {
  return {
    background: { shape: 'squircle', color: '#4f46e5', color2: '' },
    iconColor: '#ffffff',
    accentColor: '#f59e0b',
    badgeIconColor: '#ffffff',
    strokeWidth: 2,
    badgePosition: 'br',
    family: 'auto',
    notes: '',
  };
}

/** AIの出力や画面入力からスタイルガイドを検証・補正する */
export function normalizeGuide(raw) {
  const d = defaultGuide();
  const b = raw?.background || {};
  const shape = b.shape === 'none' || SHAPES[b.shape] ? b.shape : d.background.shape;
  const bgColor = color(b.color, d.background.color);
  return {
    background: { shape, color: bgColor, color2: b.color2 ? color(b.color2, '') : '' },
    iconColor: color(raw?.iconColor, shape === 'none' ? '#1f2937' : d.iconColor),
    accentColor: color(raw?.accentColor, d.accentColor),
    badgeIconColor: color(raw?.badgeIconColor, d.badgeIconColor),
    strokeWidth: num(raw?.strokeWidth, 1, 3.5, d.strokeWidth),
    badgePosition: BADGE_POSITIONS[raw?.badgePosition] ? raw.badgePosition : 'auto',
    family: FAMILIES[raw?.family] ? raw.family : 'auto',
    notes: String(raw?.notes || '').slice(0, 300),
  };
}

/** AIに渡すスタイルガイドの説明 */
export function describeGuide(g) {
  return `Style guide (MUST follow; colors and stroke widths are also auto-unified afterwards):
- background: shape "${g.background.shape}", color ${g.background.color}${g.background.color2 ? ` → gradient to ${g.background.color2}` : ''}
- main icon color: ${g.iconColor}; accent color (badges, modifier shapes): ${g.accentColor}; icon/text color on top of accent shapes: ${g.badgeIconColor}
- strokeWidth for line icons: ${g.strokeWidth}
- badge/modifier position: ${g.badgePosition === 'auto' ? 'your choice' : { br: 'bottom-right', bl: 'bottom-left', tr: 'top-right', tl: 'top-left' }[g.badgePosition]}
- icon family: ${FAMILY_TEXT[g.family]}${g.notes ? `\n- notes: ${g.notes}` : ''}`;
}

export const FAMILY_TEXT = {
  auto: 'choose ONE family per icon set (line icons, or solid pictograms) and do not mix them within an icon',
  line: 'LINE icons only (Lucide / Tabler outline). Hand-drawn parts must also be strokes with the same visual line width',
  solid: 'SOLID filled pictograms only (Pinhead / Material Symbols / Tabler Filled). Hand-drawn parts must be filled shapes or thick strokes (about size × 0.08) matching the pictogram limbs',
};
const BADGE_TARGET = { br: [71, 71], bl: [29, 71], tr: [71, 29], tl: [29, 29] };

/**
 * コンポジションにスタイルガイドを強制適用する（AIの出力のばらつきを抑える）
 * - 背景の形と色
 * - メインアイコン（最大のアイコン）の色・線の太さ
 * - バッジ（メイン以外の小さなパーツ）の色・線の太さ・位置
 * - くり抜き縁の色を背後の色に合わせる
 */
export function applyStyleGuide(comp, g) {
  const c = clone(comp);
  if (!g) return c;
  const bg = c.background;
  bg.shape = g.background.shape;
  bg.color = g.background.color;
  bg.color2 = g.background.color2 || '';
  bg.size = bg.size || 100;

  const visible = c.layers.filter((l) => !l.hidden);
  // 描画レイヤー（AIが直接描いたもの）は色を持っているので再着色しない。位置と背景だけ揃える
  const icons = visible.filter((l) => l.type === 'icon' || l.type === 'draw');
  if (!icons.length) return c;
  const isStroke = (l) => getIcon(l.icon)?.style !== 'fill';
  const order = (l) => c.layers.indexOf(l);
  const hasRoles = visible.some((l) => l.role);

  let main, backing, badges, others;
  if (hasRoles) {
    // AIが役割を付けている場合はそれに従う（情景の部品を「バッジ」と誤判定して動かさない）
    main = icons.find((l) => l.role === 'main') || icons.reduce((a, b) => (b.size > a.size ? b : a));
    backing = visible.filter((l) => l.type === 'shape' && l.role !== 'badge' && l.size >= 90);
    badges = visible.filter((l) => l.role === 'badge');
    others = visible.filter((l) => !backing.includes(l) && !badges.includes(l));
  } else {
    main = icons.reduce((a, b) => (b.size > a.size ? b : a));
    // メインと同程度以上の大きさの図形は「土台」扱い（背景の代わり）
    backing = visible.filter((l) => l.type === 'shape' && l.size >= main.size * 0.9);
    const rest = visible.filter((l) => l !== main && !backing.includes(l));
    badges = rest.filter((l) => l.size < main.size * 0.75);
    others = [main, ...rest.filter((l) => !badges.includes(l))];
  }
  backing.forEach((l) => { l.color = g.background.color; });

  // メイン・情景の部品: アイコンはメインの色に。
  // 役割付き（アイコンと手描きの混在）のときは、AIが手描きの線と合わせた線の太さを変えない
  for (const l of others) {
    if (l.type !== 'icon') continue;
    l.color = g.iconColor;
    if (!hasRoles && isStroke(l)) l.strokeWidth = g.strokeWidth;
  }

  // バッジ: アクセント色。小さいアイコンほど線を少し太くして見た目の太さを揃える
  const onAccentShape = (l) => badges.some((s) => s.type === 'shape' && order(s) < order(l)
    && Math.hypot(s.x - l.x, s.y - l.y) < s.size / 2);
  for (const l of badges) {
    if (l.type === 'shape') l.color = g.accentColor;
    else if (l.type === 'icon') {
      if (isStroke(l)) l.strokeWidth = Math.round(g.strokeWidth * Math.min(1.6, Math.max(1, Math.sqrt(main.size / l.size))) * 4) / 4;
      l.color = onAccentShape(l) ? g.badgeIconColor : g.accentColor;
    } else if (l.type === 'text') {
      l.color = onAccentShape(l) ? g.badgeIconColor : g.accentColor;
    }
  }

  // バッジ位置: バッジ群をまとめて指定の角へ
  if (BADGE_TARGET[g.badgePosition] && badges.length) {
    const minX = Math.min(...badges.map((l) => l.x - l.size / 2)), maxX = Math.max(...badges.map((l) => l.x + l.size / 2));
    const minY = Math.min(...badges.map((l) => l.y - l.size / 2)), maxY = Math.max(...badges.map((l) => l.y + l.size / 2));
    const [tx, ty] = BADGE_TARGET[g.badgePosition];
    const dx = tx - (minX + maxX) / 2, dy = ty - (minY + maxY) / 2;
    badges.forEach((l) => { l.x = Math.round((l.x + dx) * 10) / 10; l.y = Math.round((l.y + dy) * 10) / 10; });
  }

  // くり抜き縁は背後の色に合わせる
  const behind = (l) => {
    const b = backing.find((s) => order(s) < order(l) && Math.hypot(s.x - l.x, s.y - l.y) < s.size / 2);
    if (b) return b.color;
    if (bg.shape !== 'none') return bg.color2 && l.x + l.y > 100 ? bg.color2 : bg.color;
    return '#ffffff';
  };
  visible.forEach((l) => { if (l.halo > 0) l.haloColor = behind(l); });
  return c;
}
