// Copies the flag SVGs we need from the flag-icons package into public/flags
// so they ship with the build (no runtime fetches to external URLs).
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
const meta = JSON.parse(readFileSync(new URL('../src/data/countries-meta.json', import.meta.url), 'utf8'));
const src = new URL('../node_modules/flag-icons/flags/4x3/', import.meta.url);
const dst = new URL('../public/flags/', import.meta.url);
mkdirSync(dst, { recursive: true });
let n = 0;
for (const c of Object.values(meta)) {
  const f = new URL(`${c.a2}.svg`, src);
  if (existsSync(f)) { copyFileSync(f, new URL(`${c.a2}.svg`, dst)); n++; }
}
console.log('copied', n, 'flags');
