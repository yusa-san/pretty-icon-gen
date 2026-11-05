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
    url: 'https://lucide.dev', style: 'stroke',
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
    ['tabler', 'Tabler', 'tabler-nodes-outline.json', 'stroke'],
    ['tabler-filled', 'Tabler Filled', 'tabler-nodes-filled.json', 'fill'],
  ];
  for (const [id, label, file, style] of variants) {
    const nodes = readJSON(join(dir, file));
    const si = sets.push({
      id, name: label, version: pkg.version, license: 'MIT',
      url: 'https://tabler.io/icons', style, licenseText,
    }) - 1;
    for (const [name, n] of Object.entries(nodes)) {
      const m = meta[name] || {};
      const t = [...(m.tags || []), m.category || ''].filter(Boolean).map(String);
      icons.push([si, name, [...new Set(t)].join(','), nodesToMarkup(n)]);
    }
  }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/icons.json', JSON.stringify({ generated: new Date().toISOString(), sets, icons }));
console.log(`wrote data/icons.json: ${icons.length} icons in ${sets.length} sets`);
