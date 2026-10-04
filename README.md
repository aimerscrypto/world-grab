# 🌍 World Grab

**World Grab** is a real-time conquest strategy game played on a real map of the world, in the
spirit of *State.io* and *Galcon*. Every country is a territory. Drag from one of your countries
to a neighbour to send troops, capture it, and keep going until you own the whole map.

The map is a tilted 3D diorama: countries are extruded, bevelled slabs on an animated ocean,
with glowing borders in each empire's colour, marching soldier units, shockwaves and colour
floods when a country falls.

## Features

- **Real geography**: Natural Earth 1:50m borders (`world-atlas`) with country metadata from
  `world-countries` (names, capitals, regions, areas) and SVG flags from `flag-icons`.
- **7 battlefields**: Europe, Africa, Asia, North America, South America, Oceania and the
  whole World, each with its own fitted projection (conic for Europe and North America,
  azimuthal for Africa / Asia / South America / Oceania, Natural Earth for the World).
- **One-gesture controls**: drag to attack, drag *through* several of your countries to attack
  from all of them at once, drop on your own country to reinforce. Tap for a country card
  (flag, capital, owner, troops).
- **Sea routes**: islands and isolated land clusters are linked by animated dotted routes, so
  every map is fully connected.
- **Rule-based bots** with Easy / Normal / Hard profiles. They grab weak neutrals, attack when
  they have a clear advantage, reinforce threatened borders, gang up on runaway leaders and
  fight each other too.
- **Juice**: capture shockwaves, colour wipes, bouncing slabs, sparks, floating texts, combo
  callouts ("TRIPLE GRAB!"), camera shake, screen-edge alerts and animated number roll-ups.
- **Procedural audio**: every sound effect and the ambient music loop are synthesised with the
  Web Audio API — no audio files.
- **Progress**: wins per region and difficulty, fastest wins, countries captured and a flag
  collection, saved in `localStorage`.
- **Onboarding**: an interactive hand-guided tutorial, replayable from Settings.
- **End-of-match timelapse**: watch the map change colour over the whole match.
- **Runs on phones**: touch + pinch, portrait and landscape, automatic quality scaling
  (bloom off, lower pixel ratio) when the frame rate drops.

## Tech stack

- [Vite](https://vitejs.dev/) + TypeScript
- [Three.js](https://threejs.org/) — custom shaders for the slabs, ocean, borders and FX;
  instanced rendering for troop units; optional `UnrealBloomPass`
- [d3-geo](https://github.com/d3/d3-geo) for projections, clipping and graticules
- [topojson-client](https://github.com/topojson/topojson-client) /
  [topojson-simplify](https://github.com/topojson/topojson-simplify) for topology-preserving
  simplification, merging and land-neighbour detection
- `world-atlas`, `world-countries`, `flag-icons`, `@fontsource` (Lilita One + Nunito)

Everything is bundled locally: no runtime requests to external URLs and no API keys.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build

```bash
npm run build
npm run preview
```

The production build goes to `dist/`. Vite's `base` is set to `/world-grab/` for production so
the build works on GitHub Pages at `https://<user>.github.io/world-grab/`.

## Deploy to GitHub Pages

A workflow in `.github/workflows/deploy.yml` builds the game and deploys `dist/` on every push
to `main`. In the repository settings, set **Pages → Source** to **GitHub Actions**.

## Project layout

```
src/
  config.ts          every tuning number (growth, caps, bots, colours, camera, perf)
  app.ts             app controller: screens, boards, matches, picking, main loop
  match.ts           one match: game events -> visuals, drag-to-send input
  input.ts           mouse / touch / pinch / wheel handling
  game/              simulation (game.ts), bots (bots.ts), saved stats (stats.ts)
  map/               TopoJSON pipeline, regions & projections, picking, pole of inaccessibility
  render/            stage (renderer, bloom, adaptive quality), camera rig, board, ocean,
                     units, FX, drag arrows, GLSL shaders
  ui/                HUD, badges, menus, tutorial, floating texts, loading overlay
  audio/             Web Audio synthesiser + procedural music
scripts/             build-meta.mjs (slim country metadata), copy-flags.mjs
```

## Credits

Map data © [Natural Earth](https://www.naturalearthdata.com/) via `world-atlas`. Country data
from `world-countries` (ODbL). Flags from `flag-icons` (MIT). Fonts: Lilita One and Nunito
(SIL Open Font License).
