import { feature, merge, neighbors } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';
import type { Topology, Objects, GeometryObject, MultiPolygon, Polygon, GeometryCollection } from 'topojson-specification';
import { geoGraticule, geoPath, geoStream, type GeoProjection, type GeoStream } from 'd3-geo';
import type { Feature, Geometry, MultiPoint } from 'geojson';
import metaJson from '../data/countries-meta.json';
import { CONFIG } from '../config';
import type { CountryMeta, Poly, RegionCountry, RegionMap, SeaRoute } from './types';
import { regionById, type RegionId } from './regions';
import { polylabel } from './polylabel';
import { bboxDist, cleanRing, pointInRing, ringArea, ringBBox } from './geom';

const META = metaJson as unknown as Record<string, CountryMeta>;

/** A country after merging odd features, before projection. */
export interface GlobalCountry {
  key: string;
  meta: CountryMeta;
  geoms: GeometryObject[];
  areaKm2: number;
  neighbours: Set<number>;
}

interface WorldData {
  topo: Topology;
  presimplified: Topology;
  countries: GlobalCountry[];
}

let worldPromise: Promise<WorldData> | null = null;
const regionCache = new Map<RegionId, RegionMap>();

/** Loads and pre-processes the world topology once (code-split chunk). */
export function loadWorld(): Promise<WorldData> {
  if (!worldPromise) {
    worldPromise = import('world-atlas/countries-50m.json').then((mod) => {
      const topo = ((mod as { default?: unknown }).default ?? mod) as Topology;
      return prepareWorld(topo);
    });
  }
  return worldPromise;
}

type AnyGeom = GeometryObject & { id?: string | number };
const nameOf = (g: AnyGeom): string => (g.properties as { name?: string } | undefined)?.name ?? '';
const simpleTopo = (t: Topology) => t as unknown as Topology<Objects<{}>>;

function decodeArc(topo: Topology, index: number): [number, number][] {
  const arc = topo.arcs[index < 0 ? ~index : index];
  const t = topo.transform;
  const pts: [number, number][] = [];
  let x = 0, y = 0;
  for (const p of arc) {
    if (t) {
      x += p[0]; y += p[1];
      pts.push([x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]);
    } else pts.push([p[0], p[1]]);
  }
  if (index < 0) pts.reverse();
  return pts;
}

/** Strips far-flung overseas polygons according to CONFIG.map.polygonFilters. */
function applyPolygonFilter(topo: Topology, g: AnyGeom, box: [number, number, number, number]) {
  if (g.type !== 'MultiPolygon') return;
  const mp = g as unknown as MultiPolygon;
  const kept = mp.arcs.filter((poly) => {
    let sx = 0, sy = 0, n = 0;
    for (const arcIdx of poly[0]) {
      for (const p of decodeArc(topo, arcIdx)) { sx += p[0]; sy += p[1]; n++; }
    }
    if (!n) return false;
    const lon = sx / n, lat = sy / n;
    return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
  });
  if (kept.length) mp.arcs = kept;
}

function prepareWorld(topo: Topology): WorldData {
  const coll = topo.objects.countries as GeometryCollection;
  const geoms = coll.geometries as AnyGeom[];
  const cfg = CONFIG.map;

  for (const g of geoms) {
    const id = g.id != null ? String(g.id) : '';
    const box = cfg.polygonFilters[id];
    if (box) applyPolygonFilter(topo, g, box);
  }

  const nb = neighbors(geoms as GeometryObject[]);
  const keyOf = (g: AnyGeom) => (g.id != null ? String(g.id) : (nameOf(g) || '?'));

  // 1) decide which geometries are "real" countries
  const target: (number | null)[] = geoms.map(() => null); // geometry -> owning geometry index
  const isKept: boolean[] = geoms.map(() => false);
  geoms.forEach((g, i) => {
    const key = keyOf(g);
    if (cfg.exclude.includes(key)) return;
    if (cfg.mergeInto[key] || cfg.mergeInto[nameOf(g)]) return;
    const meta = META[key];
    if (!meta) return;
    if (!meta.ind && meta.area < cfg.minTerritoryAreaKm2) return;
    isKept[i] = true;
    target[i] = i;
  });
  // 2) resolve merges for the rest
  geoms.forEach((g, i) => {
    if (isKept[i]) return;
    const key = keyOf(g);
    if (cfg.exclude.includes(key)) return;
    const explicit = cfg.mergeInto[key] ?? cfg.mergeInto[nameOf(g)];
    if (explicit === '__drop') return;
    if (explicit) {
      const j = geoms.findIndex((h) => keyOf(h) === explicit);
      if (j >= 0 && isKept[j]) { target[i] = j; return; }
    }
    // generic fallback: merge into the largest kept land neighbour, else drop
    let best = -1, bestArea = -1;
    for (const j of nb[i]) {
      if (!isKept[j]) continue;
      const a = META[keyOf(geoms[j])]?.area ?? 0;
      if (a > bestArea) { bestArea = a; best = j; }
    }
    if (best >= 0) target[i] = best;
  });

  // 3) build merged country list
  const countries: GlobalCountry[] = [];
  const geomToCountry = new Map<number, number>();
  geoms.forEach((g, i) => {
    if (!isKept[i]) return;
    const key = keyOf(g);
    geomToCountry.set(i, countries.length);
    countries.push({ key, meta: META[key], geoms: [g], areaKm2: META[key].area, neighbours: new Set() });
  });
  geoms.forEach((g, i) => {
    const t = target[i];
    if (t == null || t === i) return;
    const ci = geomToCountry.get(t);
    if (ci == null) return;
    countries[ci].geoms.push(g);
    countries[ci].areaKm2 += META[keyOf(g)]?.area ?? 0;
    geomToCountry.set(i, ci);
  });
  geoms.forEach((_, i) => {
    const ci = geomToCountry.get(i);
    if (ci == null) return;
    for (const j of nb[i]) {
      const cj = geomToCountry.get(j);
      if (cj != null && cj !== ci) countries[ci].neighbours.add(cj);
    }
  });

  const presimplified = presimplify(simpleTopo(topo)) as unknown as Topology;
  return { topo, presimplified, countries };
}

// ---------------------------------------------------------------------------
// Region build
// ---------------------------------------------------------------------------

/** Collects projected polygons from a d3 stream, classifying holes by nesting. */
function projectGeometry(geo: Geometry, projection: GeoProjection): number[][][] {
  const polys: number[][][] = [];
  let ringsInPoly: number[][] | null = null;
  let ring: number[] = [];
  const sink: GeoStream = {
    point(x: number, y: number) { ring.push(x, y); },
    lineStart() { ring = []; },
    lineEnd() { if (ringsInPoly) ringsInPoly.push(ring); },
    polygonStart() { ringsInPoly = []; },
    polygonEnd() {
      if (ringsInPoly) polys.push(...classifyRings(ringsInPoly));
      ringsInPoly = null;
    },
    sphere() {},
  };
  geoStream({ type: 'Feature', properties: {}, geometry: geo } as Feature, projection.stream(sink));
  return polys;
}

function classifyRings(rings: number[][]): number[][][] {
  const items = rings
    .map((r) => cleanRing(r))
    .filter((r) => r.length >= 6)
    .map((r) => ({ r, a: Math.abs(ringArea(r)), depth: 0, parent: -1 }))
    .sort((p, q) => q.a - p.a);
  for (let i = 0; i < items.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (pointInRing(items[i].r[0], items[i].r[1], items[j].r)) {
        items[i].depth = items[j].depth + 1;
        items[i].parent = j;
        break;
      }
    }
  }
  const out: number[][][] = [];
  const outIndex = new Map<number, number>();
  items.forEach((it, i) => {
    if (it.depth % 2 === 0) {
      outIndex.set(i, out.length);
      out.push([it.r]);
    } else {
      const o = outIndex.get(it.parent);
      if (o != null) out[o].push(it.r);
    }
  });
  return out;
}

function focusPoints(f: [number, number, number, number]): MultiPoint {
  const pts: [number, number][] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      let lon = f[0] + ((f[2] - f[0]) * i) / steps;
      if (lon > 180) lon -= 360;
      pts.push([lon, f[1] + ((f[3] - f[1]) * j) / steps]);
    }
  }
  return { type: 'MultiPoint', coordinates: pts };
}

export async function buildRegion(id: RegionId): Promise<RegionMap> {
  const cached = regionCache.get(id);
  if (cached) return cached;
  const world = await loadWorld();
  const def = regionById(id);
  const cfg = CONFIG.map;

  // topology-preserving simplification: neighbours keep identical borders
  const keep = cfg.simplifyKeep[id] ?? 0.3;
  const simp = simplify(simpleTopo(world.presimplified), quantile(simpleTopo(world.presimplified), keep));

  // projection fitted to the focus box
  const PX = 1000;
  const projection = def.projection();
  const focus = focusPoints(def.focus);
  projection.fitWidth(PX, focus);
  const b = geoPath(projection).bounds(focus);
  const pad = PX * 0.01;
  projection.clipExtent([[b[0][0] - pad, b[0][1] - pad], [b[1][0] + pad, b[1][1] + pad]]);
  projection.precision(cfg.projectionPrecision);
  const cx = (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
  const k = cfg.width / (b[1][0] - b[0][0]);
  const width = cfg.width;
  const height = (b[1][1] - b[0][1]) * k;
  const boardArea = width * height;

  type Proto = Omit<RegionCountry, 'idx' | 'landNeighbours' | 'neighbours'> & { g: number };
  const protos: Proto[] = [];
  world.countries.forEach((gc, gi) => {
    const projectFrom = (topo: Topology): Poly[] => {
      const geo: Geometry = gc.geoms.length === 1
        ? (feature(topo, gc.geoms[0]) as Feature).geometry
        : merge(topo, gc.geoms as (Polygon | MultiPolygon)[]);
      if (!geo) return [];
      return projectGeometry(geo, projection)
        .map((rings) => {
          const tr = rings.map((r) => {
            const o = new Array<number>(r.length);
            for (let i = 0; i < r.length; i += 2) {
              o[i] = (r[i] - cx) * k;
              o[i + 1] = -(r[i + 1] - cy) * k;
            }
            return o;
          });
          const holesArea = tr.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
          return { outer: tr[0], holes: tr.slice(1), area: Math.abs(ringArea(tr[0])) - holesArea, bbox: ringBBox(tr[0]) };
        })
        .filter((p) => p.area > 0)
        .sort((p, q) => q.area - p.area);
    };
    let polys = projectFrom(simp);
    // tiny countries can collapse under simplification: use full detail for them
    const smallA = boardArea * cfg.tinyCountryAreaFrac * 4;
    if (!polys.length || polys.reduce((s, p) => s + p.area, 0) < smallA) {
      const full = projectFrom(world.presimplified);
      if (full.length) polys = full;
    }
    if (!polys.length) return;
    const minA = boardArea * cfg.minPolygonAreaFrac;
    polys = polys.filter((p, i) => i === 0 || p.area >= minA);
    const area = polys.reduce((s, p) => s + p.area, 0);
    const playable = def.member(gc.meta, gc.key);
    const main = polys[0];
    const anchor = polylabel([main.outer, ...main.holes], Math.max(0.01, Math.sqrt(main.area) * 0.02));
    let radius = 0;
    const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of polys) {
      for (let i = 0; i < p.outer.length; i += 2) {
        radius = Math.max(radius, Math.hypot(p.outer[i] - anchor[0], p.outer[i + 1] - anchor[1]));
      }
      bb[0] = Math.min(bb[0], p.bbox[0]); bb[1] = Math.min(bb[1], p.bbox[1]);
      bb[2] = Math.max(bb[2], p.bbox[2]); bb[3] = Math.max(bb[3], p.bbox[3]);
    }
    protos.push({
      g: gi,
      key: gc.key,
      name: gc.meta.n,
      a2: gc.meta.a2,
      flagEmoji: gc.meta.f,
      capital: gc.meta.cap || '—',
      subregion: gc.meta.sr || gc.meta.r,
      areaKm2: gc.areaKm2,
      playable,
      polygons: polys,
      area,
      anchor,
      radius: Math.max(radius, 0.01),
      bbox: bb,
      tiny: playable && area < boardArea * cfg.tinyCountryAreaFrac,
    });
  });

  // playable first, then background
  protos.sort((p, q) => Number(q.playable) - Number(p.playable));
  const gToIdx = new Map<number, number>();
  protos.forEach((p, i) => gToIdx.set(p.g, i));
  const playableCount = protos.filter((p) => p.playable).length;
  const countries: RegionCountry[] = protos.map((p, i) => {
    const { g, ...rest } = p;
    const land: number[] = [];
    if (p.playable) {
      for (const gn of world.countries[g].neighbours) {
        const j = gToIdx.get(gn);
        if (j != null && j < playableCount) land.push(j);
      }
    }
    return { ...rest, idx: i, landNeighbours: land, neighbours: [...land] };
  });

  const unitRaw = Math.sqrt(boardArea / Math.max(1, playableCount)) * CONFIG.unitScale.factor;
  const unit = Math.min(CONFIG.unitScale.max, Math.max(CONFIG.unitScale.min, unitRaw));

  // km -> units scale at the focus centre
  const fc = [(def.focus[0] + def.focus[2]) / 2, (def.focus[1] + def.focus[3]) / 2];
  const pA = projection([fc[0] > 180 ? fc[0] - 360 : fc[0], fc[1]]);
  const pB = projection([fc[0] > 180 ? fc[0] - 360 : fc[0], fc[1] + 1]);
  const kmToUnits = pA && pB ? (Math.hypot(pA[0] - pB[0], pA[1] - pB[1]) * k) / 111.2 : width / 8000;

  const seaRoutes = computeSeaRoutes(countries, playableCount, kmToUnits * cfg.seaRouteMaxKm, width);

  // graticule
  const graticule: number[][] = [];
  {
    let line: number[] = [];
    const sink: GeoStream = {
      point(x: number, y: number) { line.push((x - cx) * k, -(y - cy) * k); },
      lineStart() { line = []; },
      lineEnd() { if (line.length >= 4) graticule.push(line); },
      polygonStart() {},
      polygonEnd() {},
      sphere() {},
    };
    geoStream(geoGraticule().step([10, 10])(), projection.stream(sink));
  }

  // typical neighbour distance (median)
  const dists: number[] = [];
  for (let i = 0; i < playableCount; i++) {
    for (const j of countries[i].neighbours) {
      if (j > i) dists.push(Math.hypot(countries[i].anchor[0] - countries[j].anchor[0], countries[i].anchor[1] - countries[j].anchor[1]));
    }
  }
  dists.sort((a, z) => a - z);
  const typicalDist = dists.length ? dists[Math.floor(dists.length / 2)] : width / 10;

  const map: RegionMap = { def, countries, playableCount, width, height, unit, seaRoutes, graticule, typicalDist };
  regionCache.set(id, map);
  return map;
}

// ---------------------------------------------------------------------------
// Sea routes
// ---------------------------------------------------------------------------

function samplePoints(c: RegionCountry, maxPts: number): number[] {
  const all: number[] = [];
  for (const p of c.polygons) for (let i = 0; i < p.outer.length; i++) all.push(p.outer[i]);
  const n = all.length / 2;
  if (n <= maxPts) return all;
  const out: number[] = [];
  const step = n / maxPts;
  for (let s = 0; s < n; s += step) {
    const i = Math.floor(s);
    out.push(all[i * 2], all[i * 2 + 1]);
  }
  return out;
}

function closest(a: number[], b: number[]): { d: number; pa: [number, number]; pb: [number, number] } {
  let best = Infinity, ia = 0, ib = 0;
  for (let i = 0; i < a.length; i += 2) {
    for (let j = 0; j < b.length; j += 2) {
      const dx = a[i] - b[j], dy = a[i + 1] - b[j + 1];
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; ia = i; ib = j; }
    }
  }
  return { d: Math.sqrt(best), pa: [a[ia], a[ia + 1]], pb: [b[ib], b[ib + 1]] };
}

function computeSeaRoutes(countries: RegionCountry[], n: number, maxDist: number, width: number): SeaRoute[] {
  const cfg = CONFIG.map;
  const maxLen = width * cfg.seaRouteMaxBoardFrac;
  const samples: number[][] = [];
  for (let i = 0; i < n; i++) samples.push(samplePoints(countries[i], 90));
  const routes: SeaRoute[] = [];
  const has = new Set<string>();
  const add = (a: number, b: number, pa: [number, number], pb: [number, number]) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (has.has(key) || countries[a].landNeighbours.includes(b)) return;
    has.add(key);
    routes.push({ a, b, pa, pb });
    countries[a].neighbours.push(b);
    countries[b].neighbours.push(a);
  };

  // 1) islands: routes to every country within reach (closest first)
  for (let i = 0; i < n; i++) {
    if (countries[i].landNeighbours.length) continue;
    const cands: { j: number; d: number; pa: [number, number]; pb: [number, number] }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (bboxDist(countries[i].bbox, countries[j].bbox) > maxDist) continue;
      const c = closest(samples[i], samples[j]);
      if (c.d <= maxDist && c.d <= maxLen) cands.push({ j, ...c });
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands.slice(0, cfg.seaRouteMaxPerCountry)) add(i, c.j, c.pa, c.pb);
  }

  // 2) guarantee the whole board is connected (union-find over components)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (x: number, y: number) => { parent[find(x)] = find(y); };
  for (let i = 0; i < n; i++) for (const j of countries[i].neighbours) union(i, j);
  let guard = 0;
  for (;;) {
    const roots = new Set<number>();
    for (let i = 0; i < n; i++) roots.add(find(i));
    if (roots.size <= 1 || guard++ > 200) break;
    // connect the smallest component to its nearest outside country
    const sizes = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!sizes.has(r)) sizes.set(r, []);
      sizes.get(r)!.push(i);
    }
    const comp = [...sizes.values()].sort((p, q) => p.length - q.length)[0];
    const inComp = new Set(comp);
    let best: { a: number; b: number; d: number; pa: [number, number]; pb: [number, number] } | null = null;
    // prefilter by bbox distance
    const pairs: [number, number, number][] = [];
    for (const a of comp) {
      for (let j = 0; j < n; j++) {
        if (inComp.has(j)) continue;
        pairs.push([a, j, bboxDist(countries[a].bbox, countries[j].bbox)]);
      }
    }
    pairs.sort((p, q) => p[2] - q[2]);
    for (const [a, j, bd] of pairs.slice(0, 60)) {
      if (best && bd > best.d) break;
      const c = closest(samples[a], samples[j]);
      if (!best || c.d < best.d) best = { a, b: j, ...c };
    }
    if (!best) break;
    add(best.a, best.b, best.pa, best.pb);
    union(best.a, best.b);
  }
  return routes;
}

/** Board silhouettes for the map-select cards (SVG path strings). */
export async function regionSilhouette(id: RegionId, w: number, h: number): Promise<string> {
  const world = await loadWorld();
  const def = regionById(id);
  const simp = simplify(simpleTopo(world.presimplified), quantile(simpleTopo(world.presimplified), 0.04));
  const members = world.countries.filter((c) => def.member(c.meta, c.key));
  const geo = merge(simp, members.flatMap((c) => c.geoms) as (Polygon | MultiPolygon)[]);
  const projection = def.projection();
  const focus = focusPoints(def.focus);
  projection.fitSize([w, h], focus);
  const b = geoPath(projection).bounds(focus);
  projection.clipExtent(b);
  projection.precision(1);
  return geoPath(projection)(geo) ?? '';
}
