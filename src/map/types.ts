import type { RegionDef } from './regions';

/** Slim metadata produced by scripts/build-meta.mjs. */
export interface CountryMeta {
  n: string; // common name
  a2: string; // lowercase ISO alpha-2 (flag file name)
  a3: string;
  cap: string; // capital
  r: string; // region
  sr: string; // subregion
  ll: [number, number]; // lat, lng
  area: number; // km²
  ind: boolean; // independent
  f: string; // flag emoji
}

/** A projected polygon in map units. Rings are flat [x0,y0,x1,y1,...] arrays
 *  without the closing duplicate point. */
export interface Poly {
  outer: number[];
  holes: number[][];
  area: number;
  bbox: [number, number, number, number];
}

export interface RegionCountry {
  idx: number;
  key: string;
  name: string;
  a2: string;
  flagEmoji: string;
  capital: string;
  subregion: string;
  areaKm2: number;
  /** false = decorative background land on a region map */
  playable: boolean;
  polygons: Poly[];
  area: number; // map units²
  anchor: [number, number];
  /** max distance from anchor to the country outline (for the capture wipe) */
  radius: number;
  bbox: [number, number, number, number];
  tiny: boolean;
  landNeighbours: number[];
  /** land + sea-route neighbours (playable indices only) */
  neighbours: number[];
}

export interface SeaRoute {
  a: number;
  b: number;
  pa: [number, number];
  pb: [number, number];
}

export interface RegionMap {
  def: RegionDef;
  countries: RegionCountry[];
  /** playable countries occupy indices [0, playableCount) */
  playableCount: number;
  width: number;
  height: number;
  /** per-map scale unit (see CONFIG.unitScale) */
  unit: number;
  seaRoutes: SeaRoute[];
  /** projected graticule polylines (flat xy arrays) */
  graticule: number[][];
  /** median distance between neighbouring anchors */
  typicalDist: number;
}
