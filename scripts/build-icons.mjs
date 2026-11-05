// Builds data/icons.json from the npm packages of free icon sets.
// Usage: npm install && npm run build:icons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = (name) => join(process.cwd(), 'node_modules', name);
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Convert icon-node arrays ([tag, attrs][]) to SVG markup.
function nodesToMarkup(nodes) {
  return nodes
    .filter(([tag, attrs]) => !(tag === 'path' && /^M0 0h24v24H0z$/.test(attrs.d || '')))
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
}

const sets = [];
const icons = [];

// --- Lucide (ISC) ---
{
  const dir = pkgDir('lucide-static');
  const pkg = readJSON(join(dir, 'package.json'));
  const nodes = readJSON(join(dir, 'icon-nodes.json'));
  const tags = readJSON(join(dir, 'tags.json'));
  const si = sets.push({
    id: 'lucide', name: 'Lucide', version: pkg.version, license: 'ISC',
    url: 'https://lucide.dev', style: 'stroke', family: 'line',
    licenseText: readFileSync(join(dir, 'LICENSE'), 'utf8').trim(),
  }) - 1;
  for (const [name, n] of Object.entries(nodes)) {
    icons.push([si, name, (tags[name] || []).join(','), nodesToMarkup(n)]);
  }
}

// --- Tabler (MIT) outline + filled ---
{
  const dir = pkgDir('@tabler/icons');
  const pkg = readJSON(join(dir, 'package.json'));
  const meta = readJSON(join(dir, 'icons.json'));
  const licenseText = readFileSync(join(dir, 'LICENSE'), 'utf8').trim();
  const variants = [
    ['tabler', 'Tabler', 'tabler-nodes-outline.json', 'stroke', 'line'],
    ['tabler-filled', 'Tabler Filled', 'tabler-nodes-filled.json', 'fill', 'solid'],
  ];
  for (const [id, label, file, style, family] of variants) {
    const nodes = readJSON(join(dir, file));
    const si = sets.push({
      id, name: label, version: pkg.version, license: 'MIT',
      url: 'https://tabler.io/icons', style, family, licenseText,
    }) - 1;
    for (const [name, n] of Object.entries(nodes)) {
      const m = meta[name] || {};
      const t = [...(m.tags || []), m.category || ''].filter(Boolean).map(String);
      icons.push([si, name, [...new Set(t)].join(','), nodesToMarkup(n)]);
    }
  }
}

// --- Iconify形式のセット（塗りのピクトグラム） ---
// body の fill="currentColor" を外して描画側の色を効かせ、24x24 の座標系にそろえる
function iconifyBody(body, size) {
  const b = body.replace(/\s(fill|stroke)="currentColor"/g, '');
  return size === 24 ? b : `<g transform="scale(${+(24 / size).toFixed(6)})">${b}</g>`;
}

// --- Pinhead (CC0): 情景・人物の動作が豊富な地図用ピクトグラム ---
{
  const data = readJSON(join(pkgDir('@iconify-json/pinhead'), 'icons.json'));
  const pkg = readJSON(join(pkgDir('@waysidemapping/pinhead'), 'package.json'));
  const size = data.width || 15;
  const si = sets.push({
    id: 'pinhead', name: 'Pinhead', version: pkg.version, license: 'CC0-1.0',
    url: 'https://github.com/waysidemapping/pinhead', style: 'fill', family: 'solid',
    licenseText: `Pinhead Map Icons — https://github.com/waysidemapping/pinhead\nDedicated to the public domain under CC0 1.0 Universal.\n\n${readFileSync(join(pkgDir('@waysidemapping/pinhead'), 'LICENSE'), 'utf8').trim()}`,
  }) - 1;
  for (const [name, ic] of Object.entries(data.icons)) {
    if ((ic.width && ic.width !== size) || (ic.height && ic.height !== size)) continue;
    icons.push([si, name, '', iconifyBody(ic.body, size)]);
  }
}

// --- Material Symbols (Apache-2.0): 塗りの基本形のみ（outline/rounded/sharp の派生形は除く） ---
{
  const dir = pkgDir('@iconify-json/material-symbols');
  const data = readJSON(join(dir, 'icons.json'));
  const meta = readJSON(join(dir, 'metadata.json'));
  const pkg = readJSON(join(dir, 'package.json'));
  const cats = {};
  for (const [cat, names] of Object.entries(meta.categories || {})) for (const n of names) (cats[n] ||= []).push(cat.toLowerCase());
  const si = sets.push({
    id: 'material-symbols', name: 'Material Symbols', version: pkg.version, license: 'Apache-2.0',
    url: 'https://github.com/google/material-design-icons', style: 'fill', family: 'solid',
    licenseText: `Material Symbols — https://github.com/google/material-design-icons\nCopyright Google LLC. Licensed under the Apache License, Version 2.0.\n\n${readFileSync('scripts/licenses/Apache-2.0.txt', 'utf8').trim()}`,
  }) - 1;
  for (const [name, ic] of Object.entries(data.icons)) {
    if (/-(outline|rounded|sharp)(-|$)/.test(name)) continue;
    icons.push([si, name, (cats[name] || []).join(','), iconifyBody(ic.body, data.width || 24)]);
  }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/icons.json', JSON.stringify({ generated: new Date().toISOString(), sets, icons }));
console.log(`wrote data/icons.json: ${icons.length} icons in ${sets.length} sets`);
