# World Grab — build summary

All seven phases plus the final review pass are done. Each phase is its own commit, and
`npm run build` (TypeScript check + Vite build) passes with zero errors.

Per your rules I never opened the game in a browser: no Playwright and no screenshots. The
only checks were the TypeScript/Vite build and a few quick headless Node runs of the pure
simulation. Those runs confirmed that region building, sends, captures and bot-only matches
work, and timed bot-vs-bot matches. **Your first playtest is the first time anyone sees the
visuals**, so expect some tuning of colours, sizes and camera.

## What was built

**Phase 1 — Map diorama**
- Natural Earth 1:50m (`world-atlas`), joined to a slim metadata file built from
  `world-countries` (`scripts/build-meta.mjs`).
- Topology-preserving simplification per region (`topojson-simplify`). Tiny countries
  automatically fall back to full detail so no island nation disappears.
- Odd features handled:
  - Kosovo → Serbia, N. Cyprus → Cyprus, Somaliland → Somalia, Siachen → India,
    Hong Kong / Macao → China.
  - Small dependent territories are merged into a neighbour or dropped.
  - Antarctica and the French Southern Lands are excluded.
  - Overseas parts are stripped (French Guiana, Dutch Caribbean, Easter Island, Chatham Islands,
    the Aleutians west of 180°, and others).
  - Nothing crashes on missing metadata.
- Seven regions, each with a fitted projection:
  - Conic conformal: Europe (Russia cropped, Türkiye and the Caucasus included) and North America.
  - Azimuthal equal-area: Africa, Asia, South America and Oceania (Oceania adds Indonesia and Timor-Leste).
  - Natural Earth: World.
- Non-member land is drawn as dark, unplayable background land.
- Land neighbours come from `topojson.neighbors`. Islands get sea routes to every country
  within `seaRouteMaxKm`, and a union-find pass adds routes until every map is fully connected.
- Labels sit at the pole of inaccessibility of the largest polygon (own polylabel).
- All countries render as **one merged mesh**, driven by a per-country float state texture
  (colour, previous colour, wipe, height, hover, selection, flash, bounce, shake). That one
  texture powers the capture flood, the slab bounce and the hover lift. It is one draw call for
  the whole map.
- Ocean shader:
  - Animated caustics, depth gradient, and a vignette.
  - Baked texture holding a soft south-east drop shadow, a shallow-water halo, a coastal foam
    band and the projected graticule.
- Owner-coloured inner glow ribbons, bright outlines, and DOM troop badges.
  - Badges get zoom scaling, greedy overlap hiding and flags for owned countries.
- Round tokens for tiny countries, and animated dotted sea routes.
- Camera: pan with inertia, wheel zoom toward the cursor, pinch, fly-to, shake, attract drift.

**Phase 2 — Core gameplay**
- Growth tiers by real area, with caps; neutrals don't grow.
- Drag to send 60%. Drag *through* several of your countries to send from all of them.
- Drop on your own country to reinforce.
- Arrows snap to valid targets; invalid targets tint red and shake.
- Units march in three lanes along curved arcs with bobbing, glow and trails, and fight
  one-for-one on arrival.
- Tap for an info card. Win/lose detection, pause, 1x/2x speed.

**Phase 3 — Bots**
- Easy / Normal / Hard profiles: think interval, reaction delay, advantage needed, actions per
  think, reinforce chance, gang-up threshold, growth multiplier.
- Bots grab weak neutrals and attack weak enemy borders (including each other).
- They pile onto a runaway leader and reinforce threatened borders from the interior.
- They get bolder over time. A stalemate breaker kicks in after 45 s without growth.
- Every think is wrapped so a bot can never freeze a match.

**Phase 4 — Menus and flow**
- Loading screen, then the title screen with an animated logo. Behind it, a live 5-bot World
  match drifts slowly and restarts itself.
- Map select with region silhouettes, country counts, estimated length and best result.
- Setup: difficulty, 1–5 rivals, starting country or random.
- HUD: leaderboard bar, timer, pause, speed, mute, recenter, and the "Countries taken" flag drawer.
- Pause menu.
- Victory/defeat screen with counted-up stats and a looping **timelapse** of the map's
  ownership snapshots.
- Settings: sound, music, quality, replay tutorial, reset stats, lifetime stats.
- Everything is saved in `localStorage` behind try/catch.

**Phase 5 — Juice and audio**
- All audio is synthesised with Web Audio:
  - Effects: send whoosh, subtle marching ticks, clashes, capture fanfare, loss thud, alarm,
    combo sparkle, victory/defeat stings, UI clicks.
  - A procedural ambient loop: pad chords, a pentatonic arpeggio and an echo.
- Mute is remembered.
- Camera shake on big captures, a red screen-edge pulse when you're hit, DOUBLE / TRIPLE /
  QUAD GRAB combos, and number roll-ups.

**Phase 6 — Onboarding**
- Hand-guided tutorial on Europe, starting from Germany, against one passive Easy bot. Three
  steps: attack, multi-drag, reinforce. Each step waits for you to do it.
- It can be skipped, is saved as done, and can be replayed from Settings or How to play.
- Small-phone and landscape CSS passes.

**Phase 7 — Ship-ready**
- 🌍 SVG favicon, title, meta description, Open Graph and Twitter tags, and a README.
- `base: '/world-grab/'` for production builds.
- `.github/workflows/deploy.yml` deploys `dist/` to GitHub Pages on every push to `main`.
  - In the repo, set Settings → Pages → Source to "GitHub Actions".

**Final pass** fixed real bugs found on review:
- Glow ribbons, sea routes and unit trails were being back-face culled.
- Two GLSL `smoothstep` calls had undefined edge order.
- Load races between the attract restart and starting a match or the tutorial.
- The edge alarm repeated while paused.
- The hidden HUD intercepted clicks.
- Added `color-mix` fallbacks for older Safari, wired the remaining config values, and removed
  dead code.

## Simplified or skipped

- **Shadows** are baked into the ocean texture, not real-time shadow maps. The look is a soft
  drop shadow. "Ambient occlusion" is a wall darkening gradient.
- **Bloom** (`UnrealBloomPass`) only runs on the High quality level. That is the default on
  desktop; phones start at Medium. Lower levels rely on additive glow quads. Quality drops
  automatically when FPS falls: bloom off first, then lower pixel ratio.
- Units don't collide mid-route (Galcon-style); everything resolves at the target.
- **Sending rule:** by default you can send from any of your countries that is connected
  through your own territory to a country bordering the target. Travel time still scales with
  distance. For strict neighbour-only play, set `CONFIG.game.sendThroughTerritory = false`.
- A floating flag and name only appear for *your* captures and losses. Bot-vs-bot captures
  only get the shockwave and colour flood, to keep busy maps readable.
- No `og:image`: social cards need a raster screenshot, which you can add once you have one.
- The tutorial hand is an emoji (👆), not a custom illustration.
- The match timer and stats use game time, so time at 2x speed counts double.
- The Vatican is not in the 1:50m dataset. Hawaii is kept; tiny remote territories are dropped.

## Known issues / things to watch in the first playtest

1. **Never seen in a browser.** Lighting strength, slab height, badge size and glow intensity
   are the likeliest to need taste tweaks. They all live in `src/config.ts` and the uniforms
   in `src/render/board.ts`.
2. **World map bot stalemates.** Bot-only World matches still hadn't finished after 30 minutes
   of game time in the headless runs. With you playing, you break the deadlock. The title
   attract match simply restarts after `attractMaxSeconds`.
3. **Portrait phones on the World map** start zoomed out to fit the width, which leaves a lot of
   ocean above and below. Pinch to zoom.
4. **Dense areas** (Caribbean, Balkans, Gulf states at World zoom) hide neutral badges until
   you zoom in. Tokens for enclaves (San Marino, Liechtenstein, Andorra…) sit on top of their
   neighbour.
5. **Map-select country counts** are approximate for regions not built yet: members that are
   fully clipped off the board are still counted.
6. **Snapping** may pick a valid country next to an invalid one under your finger (46 px
   radius). That is intended, but watch whether it feels right.
7. **First audio**: the very first tap may be silent while the AudioContext unlocks.

## The 10 `config.ts` values to tune first for balance

| # | Value | Default | What it does |
|---|-------|---------|--------------|
| 1 | `game.sendFraction` | `0.6` | Share of troops sent per drag. Higher = faster, swingier matches. |
| 2 | `game.tiers` (`rate` / `cap` / `garrison`) | 0.55–1.7/s, caps 45–140, garrisons 5–24 | Growth and size by real area. The core economy. |
| 3 | `game.typicalTravelSeconds` | `2.4` | Travel time for a typical neighbour hop. Sets the pace on every map. |
| 4 | `game.startTroops` | `30` | Opening strength vs neutral garrisons. |
| 5 | `bots.<difficulty>.attackAdvantage` / `neutralAdvantage` | 1.9/1.5, 1.45/1.25, 1.2/1.1 | How big an edge a bot needs before attacking. Main difficulty lever. |
| 6 | `bots.<difficulty>.thinkInterval` + `reactionDelay` | Easy ~3–4 s, Hard ~1 s | How often and how quickly bots act. |
| 7 | `bots.<difficulty>.growthMultiplier` | 0.9 / 1.0 / 1.12 | Hidden economic handicap or bonus for bots. |
| 8 | `bots.aggressionRamp` + `bots.stalemateSeconds` | `0.08` / `45` | How quickly bots get bolder; anti-stalemate. |
| 9 | `game.sendThroughTerritory` | `true` | Attack from anywhere in your connected territory vs only direct neighbours. |
| 10 | `map.seaRouteMaxKm` (+ `seaRouteMaxPerCountry`) | `700` / `4` | How connected islands are. Shapes Oceania, the Caribbean and Europe's islands. |

Runners-up: `camera.tiltDeg` (24°), `slab.height` / `slab.ownedExtra`, `perf.lowFps` (42),
`fx.bloomStrength` (0.55).

## Run

```bash
npm install
npm run dev
```

`npm run build` creates `dist/`. Flags are copied from `flag-icons` into `public/flags`
automatically before `dev` and `build`.
