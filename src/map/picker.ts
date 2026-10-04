import type { RegionMap } from './types';
import { pointInRing } from './geom';

/** Uniform-grid point-in-country lookup over the playable countries. */
export class Picker {
  private cells: number[][];
  private gw: number;
  private gh: number;
  private x0: number;
  private y0: number;
  private cs: number;
  constructor(private map: RegionMap) {
    this.gw = 96;
    this.cs = map.width / this.gw;
    this.gh = Math.ceil(map.height / this.cs) + 1;
    this.x0 = -map.width / 2;
    this.y0 = -map.height / 2;
    this.cells = Array.from({ length: this.gw * this.gh }, () => []);
    for (let i = 0; i < map.playableCount; i++) {
      const b = map.countries[i].bbox;
      const cx0 = this.cx(b[0]), cx1 = this.cx(b[2]), cy0 = this.cy(b[1]), cy1 = this.cy(b[3]);
      for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) this.cells[y * this.gw + x].push(i);
    }
  }
  private cx(x: number) { return Math.max(0, Math.min(this.gw - 1, Math.floor((x - this.x0) / this.cs))); }
  private cy(y: number) { return Math.max(0, Math.min(this.gh - 1, Math.floor((y - this.y0) / this.cs))); }

  /** Country index containing the point, or -1. */
  pick(x: number, y: number): number {
    if (x < this.x0 || y < this.y0 || x > -this.x0 || y > this.y0 + this.gh * this.cs) return -1;
    const cell = this.cells[this.cy(y) * this.gw + this.cx(x)];
    for (const i of cell) {
      const c = this.map.countries[i];
      const b = c.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      for (const p of c.polygons) {
        if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3]) continue;
        if (!pointInRing(x, y, p.outer)) continue;
        let inHole = false;
        for (const h of p.holes) if (pointInRing(x, y, h)) { inHole = true; break; }
        if (!inHole) return i;
      }
    }
    return -1;
  }
}
