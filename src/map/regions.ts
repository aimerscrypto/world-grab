import {
  geoAzimuthalEqualArea,
  geoConicConformal,
  geoNaturalEarth1,
  type GeoProjection,
} from 'd3-geo';
import type { CountryMeta } from './types';

export type RegionId = 'world' | 'europe' | 'africa' | 'asia' | 'namerica' | 'samerica' | 'oceania';

export interface RegionDef {
  id: RegionId;
  name: string;
  /** Short flavour line for the map-select card. */
  blurb: string;
  /** lon/lat box [minLon, minLat, maxLon, maxLat] the board is fitted to.
   *  maxLon may exceed 180 for boxes that wrap the antimeridian. */
  focus: [number, number, number, number];
  projection: () => GeoProjection;
  member: (m: CountryMeta, ccn3: string) => boolean;
}

const EUROPE_EXTRA = new Set(['792', '268', '051', '031']); // Türkiye + Caucasus
const OCEANIA_EXTRA = new Set(['360', '626']); // Indonesia, Timor-Leste

export const REGIONS: RegionDef[] = [
  {
    id: 'europe',
    name: 'Europe',
    blurb: 'Tight borders, fast fights',
    focus: [-24, 34, 47, 71],
    projection: () => geoConicConformal().rotate([-12, 0]).parallels([40, 64]),
    member: (m, id) => m.r === 'Europe' || EUROPE_EXTRA.has(id),
  },
  {
    id: 'africa',
    name: 'Africa',
    blurb: 'Big lands, long marches',
    focus: [-25, -36, 58, 38],
    projection: () => geoAzimuthalEqualArea().rotate([-17, -2]),
    member: (m) => m.r === 'Africa',
  },
  {
    id: 'asia',
    name: 'Asia',
    blurb: 'Giants and island chains',
    focus: [26, -11, 148, 62],
    projection: () => geoAzimuthalEqualArea().rotate([-88, -30]),
    member: (m, id) => m.r === 'Asia' || id === '643',
  },
  {
    id: 'namerica',
    name: 'North America',
    blurb: 'Caribbean island hopping',
    focus: [-165, 7, -55, 70],
    projection: () => geoConicConformal().rotate([98, 0]).parallels([20, 60]),
    member: (m) => m.r === 'Americas' && m.sr !== 'South America',
  },
  {
    id: 'samerica',
    name: 'South America',
    blurb: 'A compact continent',
    focus: [-82, -56, -34, 13],
    projection: () => geoAzimuthalEqualArea().rotate([60, 20]),
    member: (m) => m.r === 'Americas' && m.sr === 'South America',
  },
  {
    id: 'oceania',
    name: 'Oceania',
    blurb: 'Sea routes everywhere',
    focus: [108, -48, 188, 6],
    projection: () => geoAzimuthalEqualArea().rotate([-148, 20]),
    member: (m, id) => m.r === 'Oceania' || OCEANIA_EXTRA.has(id),
  },
  {
    id: 'world',
    name: 'World',
    blurb: 'Every nation. One winner.',
    focus: [-180, -57, 180, 84],
    projection: () => geoNaturalEarth1(),
    member: () => true,
  },
];

export function regionById(id: RegionId): RegionDef {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[REGIONS.length - 1];
}
