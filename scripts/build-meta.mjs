// Generates src/data/countries-meta.json — a slim subset of the world-countries
// package (which is >1MB with translations) keyed by numeric ISO code (ccn3).
// Run with: node scripts/build-meta.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const all = JSON.parse(readFileSync(new URL('../node_modules/world-countries/countries.json', import.meta.url), 'utf8'));
const out = {};
for (const c of all) {
  if (!c.ccn3) continue;
  out[c.ccn3] = {
    n: c.name.common,
    a2: c.cca2.toLowerCase(),
    a3: c.cca3,
    cap: (c.capital && c.capital[0]) || '',
    r: c.region,
    sr: c.subregion || '',
    ll: c.latlng,
    area: c.area,
    ind: !!c.independent,
    f: c.flag,
  };
}
writeFileSync(new URL('../src/data/countries-meta.json', import.meta.url), JSON.stringify(out));
console.log('wrote', Object.keys(out).length, 'countries');
